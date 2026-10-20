import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ModelClient } from "../dist/runtime/src/models/client.js";
import { DEFAULT_LIMITS, emptyUsage } from "../dist/runtime/src/types.js";
import {
  Configuration,
  createOperatorConfig,
} from "../dist/runtime/src/control/config.js";

function configuration(limits = {}) {
  const route = { endpoint_id: "known", model: "model" };
  return {
    revision: "config-1",
    workspace: { revision: "workspace-1", path: "/unused" },
    model_profile_id: "models",
    validation_profile_id: "checks",
    model_profile: {
      revision: "models-1",
      activator: route,
      primitive: route,
      diagnosis: route,
    },
    validation_profile: {
      revision: "checks-1",
      backend: "bwrap",
      network: "none",
      checks: [],
      limits: {},
    },
    limits: {
      ...DEFAULT_LIMITS,
      max_input_tokens: 2000000,
      max_output_tokens: 100000,
      max_provider_retries: 0,
      ...limits,
    },
    endpoints: {
      known: {
        revision: "endpoint-1",
        protocol: "openai-chat-completions",
        base_url: "https://example.invalid/v1",
        input_cost_per_million: 1,
        output_cost_per_million: 1,
      },
    },
    engine: { binary: "/unused", sha256: "unused" },
  };
}
function response(
  message = { role: "assistant", content: "ok" },
  usage = { prompt_tokens: 10, completion_tokens: 1 },
) {
  return new Response(
    JSON.stringify({ choices: [{ message }], usage, model: "resolved-model" }),
  );
}
const messages = [{ role: "user", content: "Test model boundary." }];
const client = (config = configuration(), onUsage = () => {}) =>
  new ModelClient(config, emptyUsage(), new AbortController().signal, onUsage);

test("reported usage overrun is persisted and rejects the completion before a tool can escape", async (t) => {
  const ledger = [];
  const model = client(configuration({ max_output_tokens: 32 }), (usage) =>
    ledger.push(usage),
  );
  t.mock.method(globalThis, "fetch", async () =>
    response(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "unsafe-over-budget",
            type: "function",
            function: { name: "propose_patch", arguments: "{}" },
          },
        ],
      },
      { prompt_tokens: 10, completion_tokens: 33 },
    ),
  );
  await assert.rejects(model.complete("primitive", messages, []), {
    code: "BUDGET_EXCEEDED",
  });
  assert.equal(model.usage.output_tokens, 33);
  assert.equal(ledger.at(-1).output_tokens, 33);
  assert.equal(model.usage.model_calls, 1);
});

test("malformed tool output retains reported overrun and actual priced usage before failure", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return response(
      { role: "assistant", content: null, tool_calls: [null] },
      { prompt_tokens: 3000000, completion_tokens: 1000 },
    );
  });
  const saved = [],
    model = client(configuration({ max_provider_retries: 2 }), (usage) =>
      saved.push(usage),
    );
  await assert.rejects(model.complete("primitive", messages, []), {
    code: "BUDGET_EXCEEDED",
  });
  assert.equal(requests, 1);
  assert.equal(model.usage.input_tokens, 3000000);
  assert.equal(model.usage.output_tokens, 1000);
  assert.equal(model.usage.estimated_input_tokens, 0);
  assert.equal(model.usage.estimated_output_tokens, 0);
  assert.equal(model.usage.cost_usd, 3.001);
  assert.equal(saved.at(-1).input_tokens, 3000000);
  assert.equal(saved.at(-1).cost_usd, 3.001);
});

test("malformed payloads and oversized metadata keep observed billing without network retries", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: requests === 3 ? "x".repeat(257) : "stop",
            message:
              requests === 1
                ? { role: "assistant", content: null, tool_calls: [null] }
                : { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        model: requests === 2 ? "x".repeat(257) : "resolved-model",
      }),
    );
  });
  const malformed = client(configuration({ max_provider_retries: 2 }));
  await assert.rejects(malformed.complete("primitive", messages, []), {
    code: "MODEL_OUTPUT_INVALID",
  });
  assert.equal(requests, 1);
  assert.equal(malformed.usage.cost_usd, 0.000011);
  assert.equal(malformed.usage.input_tokens, 10);
  assert.equal(malformed.usage.estimated_input_tokens, 0);
  const oversized = client(configuration({ max_provider_retries: 2 }));
  await assert.rejects(oversized.complete("primitive", messages, []), {
    code: "MODEL_OUTPUT_INVALID",
  });
  assert.equal(requests, 2);
  assert.equal(oversized.usage.cost_usd, 0.000011);
  assert.deepEqual(oversized.usage.resolved_models, []);
  const reason = client(configuration({ max_provider_retries: 2 }));
  await assert.rejects(reason.complete("primitive", messages, []), {
    code: "MODEL_OUTPUT_INVALID",
  });
  assert.equal(requests, 3);
  assert.equal(reason.usage.cost_usd, 0.000011);
});

test("partially reported usage estimates only its missing count and does not invent resolved metadata", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10 },
        }),
      ),
  );
  const model = client(),
    completion = await model.complete("primitive", messages, [], undefined, {
      maxOutputTokens: 32,
    });
  assert.equal(completion.reported, false);
  assert.equal(completion.model, "model");
  assert.equal(completion.provider, undefined);
  assert.equal(completion.stopReason, null);
  assert.equal(model.usage.input_tokens, 10);
  assert.equal(model.usage.estimated_input_tokens, 0);
  assert.equal(model.usage.output_tokens, 0);
  assert.equal(model.usage.estimated_output_tokens, 32);
  assert.equal(model.usage.cost_usd, 0.000042);
  assert.deepEqual(model.usage.resolved_models, []);
  assert.deepEqual(model.usage.resolved_providers, []);
});

test("unknown price stays unknown after another role makes a priced request", async (t) => {
  const config = configuration();
  config.endpoints.unknown = {
    revision: "endpoint-2",
    protocol: "openai-chat-completions",
    base_url: "https://example.invalid/unknown",
  };
  config.model_profile.primitive = { endpoint_id: "unknown", model: "other" };
  const model = client(config);
  t.mock.method(globalThis, "fetch", async () => response());
  await model.complete("primitive", messages, []);
  await model.complete("activator", messages, []);
  assert.equal(model.usage.cost_usd, null);
  assert.equal(model.usage.cost_source, "unknown");
  assert.equal(model.usage.model_calls, 2);
});

test("oversize response is cancelled and its lock released before rejection", async (t) => {
  let cancelled = 0,
    body;
  t.mock.method(globalThis, "fetch", async () => {
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1048577));
      },
      cancel() {
        cancelled++;
      },
    });
    return new Response(body);
  });
  const model = client();
  await assert.rejects(model.complete("primitive", messages, []), {
    code: "BUDGET_EXCEEDED",
  });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(model.usage.model_calls, 1);
  assert.ok(model.usage.estimated_input_tokens > 0);
});

test("transport failures are safely classified, charged and retried within the cap", async (t) => {
  let requests = 0,
    alwaysFail = false;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (alwaysFail || requests === 1)
      throw new TypeError("network failed with accidental-secret-text");
    return response();
  });
  const model = client(configuration({ max_provider_retries: 1 }));
  await model.complete("primitive", messages, []);
  assert.equal(requests, 2);
  assert.equal(model.usage.model_calls, 2);
  assert.ok(model.usage.estimated_output_tokens > 0);
  requests = 0;
  alwaysFail = true;
  const failed = client(configuration());
  await assert.rejects(
    failed.complete("primitive", messages, []),
    (error) =>
      error.code === "MODEL_ROUTE_UNAVAILABLE" &&
      !error.message.includes("accidental-secret-text"),
  );
  assert.equal(requests, 1);
});

test("an in-flight per-call cancellation aborts transport without retrying", async (t) => {
  let started = false,
    observed = false,
    requests = 0;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    requests++;
    assert.equal(options.signal.aborted, false);
    started = true;
    return new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => {
          observed = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      ),
    );
  });
  const model = client(configuration({ max_provider_retries: 2 }));
  const abort = new AbortController();
  const pending = model.complete("primitive", messages, [], undefined, {
    signal: abort.signal,
    maxOutputTokens: 1,
  });
  assert.equal(started, true);
  abort.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(observed, true);
  assert.equal(requests, 1);
  assert.equal(model.usage.estimated_output_tokens, 1);
});

test(
  "actual loopback HTTP request closes after cancellation once the endpoint received it",
  { timeout: 5000 },
  async (t) => {
    let received, disconnected;
    const receiving = new Promise((resolve) => {
      received = resolve;
    });
    const disconnecting = new Promise((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => received());
      response.on("close", () => disconnected());
      // Deliberately hold a real HTTP response open until the client cancels it.
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const config = configuration();
    config.endpoints.known.base_url = `http://127.0.0.1:${server.address().port}/v1`;
    const model = client(config),
      abort = new AbortController();
    const pending = model.complete("primitive", messages, [], undefined, {
      signal: abort.signal,
      maxOutputTokens: 1,
      timeoutMs: 1500,
    });
    const rejection = assert.rejects(pending, { code: "CANCELLED" });
    let deadline;
    const bounded = (promise) =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Loopback endpoint deadline exceeded")),
            1500,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
    try {
      await bounded(receiving);
      abort.abort();
      await rejection;
      await bounded(disconnecting);
      assert.equal(model.usage.model_calls, 1);
    } finally {
      clearTimeout(deadline);
      abort.abort();
    }
  },
);

test(
  "HTTP provider metadata is reported literally, bounded and never inferred from the requested route",
  { timeout: 5000 },
  async (t) => {
    const requestedModels = [],
      providers = [
        "provider-reported",
        undefined,
        "provider-reported",
        { id: "not-a-string" },
        "x".repeat(257),
      ];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestedModels.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")).model,
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            model: "resolved-model",
            provider: providers[requestedModels.length - 1],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
            choices: [
              {
                finish_reason:
                  requestedModels.length === 1
                    ? "stop"
                    : requestedModels.length === 3
                      ? "provider_end"
                      : undefined,
                message: { role: "assistant", content: "ok" },
              },
            ],
          }),
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const config = configuration();
    config.endpoints.known.base_url = `http://127.0.0.1:${server.address().port}/v1`;
    const legacyUsage = emptyUsage();
    delete legacyUsage.resolved_providers;
    const saved = [],
      model = new ModelClient(
        config,
        legacyUsage,
        new AbortController().signal,
        (usage) => saved.push(usage),
      );
    assert.deepEqual(model.usage.resolved_providers, []);
    const first = await model.complete("primitive", messages, []);
    assert.equal(first.model, "resolved-model");
    assert.equal(first.provider, "provider-reported");
    assert.equal(first.stopReason, "stop");
    const second = await model.complete("primitive", messages, []);
    assert.equal(second.provider, undefined);
    assert.equal(second.stopReason, null);
    assert.equal(
      (await model.complete("primitive", messages, [])).stopReason,
      "provider_end",
    );
    assert.equal(
      (await model.complete("primitive", messages, [])).provider,
      undefined,
    );
    assert.deepEqual(model.usage.resolved_models, ["resolved-model"]);
    assert.deepEqual(model.usage.resolved_providers, ["provider-reported"]);
    assert.deepEqual(saved.at(-1).resolved_providers, ["provider-reported"]);
    await assert.rejects(model.complete("primitive", messages, []), {
      code: "MODEL_OUTPUT_INVALID",
    });
    assert.deepEqual(requestedModels, [
      "model",
      "model",
      "model",
      "model",
      "model",
    ]);
    assert.equal(model.usage.input_tokens, 50);
    assert.equal(model.usage.estimated_input_tokens, 0);
    assert.equal(Object.hasOwn(legacyUsage, "resolved_providers"), false);
  },
);

test("probe rejects an empty second response even when usage and the first tool call are valid", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests++;
    if (requests === 1) {
      const nonce = JSON.parse(options.body).messages[0].content.match(
        /probe_[0-9a-f]+/,
      )[0];
      return response({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "probe-call",
            type: "function",
            function: {
              name: "capability_probe",
              arguments: JSON.stringify({ nonce }),
            },
          },
        ],
      });
    }
    return response({ role: "assistant", content: null });
  });
  await assert.rejects(client().probe(), { code: "MODEL_ROUTE_UNAVAILABLE" });
  assert.equal(requests, 2);
});

test("probe tests actual tool-result acknowledgement and records only transport cancellation evidence", async (t) => {
  let requests = 0,
    cancellationRequestTokens;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    if (requests === 1) {
      const nonce = body.messages[0].content.match(/probe_[0-9a-f]+/)[0];
      return Promise.resolve(
        response({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "probe-call",
              type: "function",
              function: {
                name: "capability_probe",
                arguments: JSON.stringify({ nonce }),
              },
            },
          ],
        }),
      );
    }
    if (requests === 2) {
      const acknowledgement = JSON.parse(
        body.messages.find((message) => message.role === "tool").content,
      ).acknowledgement;
      return Promise.resolve(
        response({ role: "assistant", content: acknowledgement }),
      );
    }
    cancellationRequestTokens = body.max_tokens;
    return new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  const model = client();
  const result = await model.probe();
  assert.equal(requests, 3);
  assert.equal(cancellationRequestTokens, 1);
  assert.equal(result.checks.length, 1);
  assert.equal(
    result.checks[0].transport_cancellation,
    "transport_abort_observed",
  );
  assert.equal(result.checks[0].provider_work_cancellation, "unverified");
  assert.equal(model.usage.model_calls, 3);
});

function configFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "primitive-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "engine");
  writeFileSync(binary, "test native binary");
  const paths = createOperatorConfig(join(root, "state"), binary);
  return { root, paths, configuration: new Configuration(paths.config_file) };
}
const clientPolicy = {
  principal: "owner",
  tool_binding: "primitive",
  workspace_ids: [],
  model_profile_ids: [],
  validation_profile_ids: [],
  actions: ["capabilities"],
};

test("failed client provisioning does not activate an unpersisted credential or leave its output file", (t) => {
  const fixture = configFixture(t),
    output = join(fixture.root, "client.json");
  renameSync(fixture.paths.config_file, fixture.paths.config_file + ".saved");
  mkdirSync(fixture.paths.config_file);
  assert.throws(() =>
    fixture.configuration.provision("client", clientPolicy, output),
  );
  assert.equal(fixture.configuration.current.clients.client, undefined);
  assert.equal(existsSync(output), false);
});

test("failed revocation rolls back the in-memory revision to the durable configuration", (t) => {
  const fixture = configFixture(t),
    output = join(fixture.root, "client.json");
  fixture.configuration.provision("client", clientPolicy, output);
  const prior = fixture.configuration.current.clients.client;
  renameSync(fixture.paths.config_file, fixture.paths.config_file + ".saved");
  mkdirSync(fixture.paths.config_file);
  assert.throws(() => fixture.configuration.revoke("client", prior.revision));
  assert.deepEqual(fixture.configuration.current.clients.client, prior);
});
