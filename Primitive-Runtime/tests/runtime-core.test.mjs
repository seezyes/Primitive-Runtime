import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../dist/runtime/src/storage/store.js";
import {
  Configuration,
  createOperatorConfig,
  narrowLimits,
} from "../dist/runtime/src/control/config.js";
import { DEFAULT_LIMITS, emptyUsage } from "../dist/runtime/src/types.js";
import { hash, atomicJSON } from "../dist/runtime/src/util.js";
import { parseAction } from "../dist/runtime/src/mcp/schema.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "primitive-core-"));
  const store = new RunStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = {
    run_id: "run",
    principal: "alice",
    tool_binding: "binding",
    client_id: "client",
    request_digest: "digest",
    request: {
      action: "start",
      client_request_id: "request",
      workspace_id: "workspace",
      task: "task",
    },
    resolved: { limits: { ...DEFAULT_LIMITS, max_messages: 3 } },
    state: "running",
    phase: "collaborating",
    verification: "not_run",
    application: "not_applicable",
    generation: 1,
    cancel_requested: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
    round_index: 0,
    usage: emptyUsage(),
    result: null,
    error: null,
  };
  store.insertRun(run);
  for (const [id, path] of [
    ["a", "a.js"],
    ["b", "b.js"],
  ])
    store.savePrimitive({
      primitive_id: id,
      run_id: "run",
      artifact_id: id,
      canonical_path: path,
      base_hash: null,
      current_hash: null,
      artifact_version: 0,
      objective: "task",
      dependency_ids: [],
      inbox_cursor: 0,
      session_id: id,
      execution_generation: 1,
      policy_revision: "primitive-policy/1",
      state: "running",
      round_index: 0,
      turns: 0,
      tool_calls: 0,
      seen_tool_ids: [],
    });
  return { dir, store, run };
}

test("addressed messages survive finish, reactivate recipient, and prevent premature quiescence", (t) => {
  const { store } = fixture(t);
  assert.equal(store.finishPrimitive("a", 1, 0, 0), true);
  assert.equal(store.finishPrimitive("b", 1, 0, 0), true);
  assert.equal(store.quiescent("run", 1, 0, 0), true);
  const payload =
    'Interface changed: preserve this literal {a:\"b\"}\nDo not paraphrase.';
  const msg = store.send("run", 1, "a", "b", "interface", payload, "message-1");
  assert.equal(msg.payload, payload);
  assert.equal(store.primitive("b").state, "runnable");
  assert.equal(store.quiescent("run", 1, 0, 0), false);
  assert.equal(store.finishPrimitive("b", 1, 0, 0), false);
  const p = store.primitive("b");
  p.inbox_cursor = msg.sequence;
  store.savePrimitive(p);
  assert.equal(store.finishPrimitive("b", 1, 0, msg.sequence), true);
  assert.equal(store.quiescent("run", 1, 0, 0), true);
  assert.equal(
    store.send("run", 1, "a", "b", "interface", payload, "message-1").sequence,
    msg.sequence,
  );
  assert.equal(store.inbox("run", "b", 0).length, 1);
});

test("cancellation fences late messages and completion before effects", (t) => {
  const { store } = fixture(t);
  const r = store.getRun("run");
  r.cancel_requested = true;
  r.generation = 2;
  store.saveRun(r);
  assert.throws(
    () => store.send("run", 1, "a", "b", "test", "late", "late-message"),
    { code: "STALE_EXECUTION" },
  );
  assert.throws(() => store.finishPrimitive("a", 1, 0, 0), {
    code: "STALE_EXECUTION",
  });
  assert.equal(store.inbox("run", "b", 0).length, 0);
});

test("artifact slices are immutable run-scoped bytes and bounded cursors", (t) => {
  const { store } = fixture(t);
  const data = "Русский текст\n";
  const id = store.artifact("run", "text/plain", data, 1000);
  const first = store.readArtifact("run", id, 0, 3);
  assert.equal(first.hash, hash(data));
  assert.equal(first.truncated, true);
  const second = store.readArtifact("run", id, 3, 1000);
  assert.equal(
    Buffer.concat([
      Buffer.from(first.content, "base64"),
      Buffer.from(second.content, "base64"),
    ]).toString(),
    data,
  );
  assert.throws(() => store.readArtifact("another-run", id, 0, 1000), {
    code: "ACCESS_DENIED",
  });
  assert.throws(() => store.eventPage("run", "NaN"), {
    code: "INVALID_ARGUMENT",
  });
});

test("expiry preserves idempotency tombstone and removes payload artifacts", (t) => {
  const { store } = fixture(t);
  const r = store.getRun("run");
  r.state = "succeeded";
  r.verification = "passed";
  r.finished_at = "2020-01-01T00:00:00Z";
  store.saveRun(r);
  const id = store.artifact("run", "text/plain", "artifact", 100);
  store.expire(7);
  assert.equal(store.findRequest("alice", "binding", "request").expired, true);
  assert.throws(() => store.readArtifact("run", id, 0, 100), {
    code: "ACCESS_DENIED",
  });
});

test("restart preserves terminal results and interrupts all abandoned work without replay", (t) => {
  const { store } = fixture(t);
  assert.equal(store.interruptAbandoned(), 1);
  const r = store.getRun("run");
  assert.equal(r.state, "interrupted");
  assert.equal(r.generation, 2);
  assert.equal(store.interruptAbandoned(), 0);
  assert.equal(store.getRun("run").state, "interrupted");
});

test("public schemas reject authority smuggling, arbitrary commands and empty identifiers", () => {
  const start = {
    action: "start",
    client_request_id: "r",
    workspace_id: "w",
    task: "task",
  };
  assert.equal(parseAction(start).task, "task");
  for (const extra of [
    { api_key: "secret" },
    { workspace_path: "/tmp" },
    { principal: "admin" },
    { command: "rm" },
    { mode: "apply" },
  ])
    assert.throws(() => parseAction({ ...start, ...extra }), {
      code: "INVALID_ARGUMENT",
    });
  assert.throws(() => parseAction({ ...start, client_request_id: "" }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(
    () => parseAction({ action: "status", run_id: "r", wait_ms: 10001 }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(
    narrowLimits(DEFAULT_LIMITS, { max_revisions: 0 }).max_revisions,
    0,
  );
  assert.throws(() => narrowLimits(DEFAULT_LIMITS, { max_parallel: 16 }), {
    code: "ACCESS_DENIED",
  });
});

test("operator revisions, credentials and role endpoints are isolated from model identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "primitive-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "native");
  writeFileSync(binary, "test");
  const { config_file, operator_client_file } = createOperatorConfig(
    join(dir, "state"),
    binary,
  );
  const config = new Configuration(config_file);
  const client = JSON.parse(readFileSync(operator_client_file, "utf8"));
  assert.equal(config.authenticate(client.token, true), true);
  assert.throws(() => config.authenticate(client.token), {
    code: "ACCESS_DENIED",
  });
  const e = config.upsert("endpoint", "model", null, {
    protocol: "openai-chat-completions",
    base_url: "http://127.0.0.1:9999/v1",
  });
  assert.throws(
    () =>
      config.upsert("endpoint", "model", null, {
        protocol: "openai-chat-completions",
        base_url: "https://example.com/v1",
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () =>
      config.upsert("endpoint", "bad", null, {
        protocol: "openai-chat-completions",
        base_url: "https://key:secret@example.com/v1",
      }),
    { code: "INVALID_ARGUMENT" },
  );
  const path = join(dir, "client.json");
  config.provision(
    "test-client",
    {
      principal: "alice",
      tool_binding: "primitive_runtime",
      workspace_ids: [],
      model_profile_ids: [],
      validation_profile_ids: [],
      actions: ["capabilities"],
    },
    path,
  );
  const credential = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.authenticate(credential.token).principal, "alice");
  assert.equal(
    JSON.stringify(config.publicConfiguration()).includes(credential.token),
    false,
  );
  const revision = config.current.clients["test-client"].revision;
  config.revoke("test-client", revision);
  assert.throws(() => config.authenticate(credential.token), {
    code: "ACCESS_DENIED",
  });
  assert.throws(
    () => new Configuration(config_file).authenticate(credential.token),
    { code: "ACCESS_DENIED" },
  );
});
