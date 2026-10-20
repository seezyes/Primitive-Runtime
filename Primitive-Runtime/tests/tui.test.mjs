import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  PanelController,
  renderFrame,
  runTui,
} from "../packages/operator-tui/src/index.mjs";
import {
  createForm,
  formRequest,
  displayField,
  publicValue,
  SECTIONS,
} from "../packages/operator-tui/src/forms.mjs";
import {
  visibleWidth,
  safeText,
  stripAnsi,
  Renderer,
  tailCells,
  C,
} from "../packages/operator-tui/src/core/render.mjs";
import { createInputDecoder } from "../packages/operator-tui/src/core/input.mjs";

const key = (name) => ({ name, sequence: name.length === 1 ? name : "" });
const inspection = (configuration) => ({
  ok: true,
  configuration,
  versions: {
    runtime_version: "0.1.0",
    engine: {
      available: true,
      hash_matches: true,
      version: { name: "jcode-primitive", version: "0.1.0" },
    },
  },
  status: { active_runs: 0, active_probes: 0, draining: false },
});
const withFields = (form, values) => {
  for (const field of form.fields)
    if (Object.hasOwn(values, field.key)) field.value = values[field.key];
  return form;
};

test("empty first-run screens and all forms fit narrow, wide and Unicode terminals", async () => {
  const controller = new PanelController({
    call: async (request) =>
      request.action === "inspect" ? inspection({}) : { ok: true, runs: [] },
  });
  await controller.refresh();
  for (const [width, height] of [
    [1, 1],
    [20, 8],
    [31, 9],
    [50, 16],
    [80, 24],
    [120, 40],
  ]) {
    for (const section of SECTIONS) {
      controller.setPage(section.id);
      let frame = renderFrame(controller.state, width, height);
      assert.equal(frame.lines.length, height);
      assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
      if (section.action) {
        controller.state.modal = { kind: "form", form: createForm(section.id) };
        controller.state.modal.form.fields[0].value = "測試 Привет 👩‍💻🇦🇹";
        frame = renderFrame(controller.state, width, height);
        assert.equal(frame.lines.length, height);
        assert.ok(
          frame.lines.every((line) => visibleWidth(line) <= width),
          `${section.id} at ${width}×${height}`,
        );
      }
    }
  }
  controller.setPage("service");
  controller.state.status.active_probes = 1;
  controller.state.status.maintenance_error = {
    code: "CONFIG_DURABILITY_UNCONFIRMED",
  };
  controller.state.status.draining = true;
  let rendered = stripAnsi(
    renderFrame(controller.state, 120, 40).lines.join("\n"),
  );
  assert.match(rendered, /Engine: jcode-primitive 0\.1\.0/);
  assert.match(rendered, /Model probes: 1/);
  assert.match(rendered, /CONFIG_DURABILITY_UNCONFIRMED/);
  assert.doesNotMatch(rendered, /\[object Object\]/);
  controller.state.connected = false;
  rendered = stripAnsi(renderFrame(controller.state, 120, 40).lines.join("\n"));
  assert.match(rendered, /SERVICE UNAVAILABLE/);
  assert.doesNotMatch(rendered, /ACCEPTING RUNS/);
});

test("endpoint form submits explicit config with CAS revision and refuses embedded credentials", () => {
  const form = withFields(
    createForm("endpoints", "gateway", {
      revision: "r2",
      base_url: "http://127.0.0.1:20128/v1",
      credential_ref: "env:MODEL_KEY",
    }),
    {
      input_cost_per_million: "0.1",
      output_cost_per_million: "",
    },
  );
  assert.deepEqual(formRequest(form), {
    action: "upsert_endpoint",
    id: "gateway",
    expected_revision: "r2",
    value: {
      protocol: "openai-chat-completions",
      base_url: "http://127.0.0.1:20128/v1",
      credential_ref: "env:MODEL_KEY",
      input_cost_per_million: 0.1,
    },
  });
  withFields(form, { base_url: "https://user:password@example.org/v1" });
  assert.throws(() => formRequest(form), /embedded credentials/);
  assert.ok(
    !displayField(
      form.fields.find((field) => field.key === "base_url"),
    ).includes("password"),
  );
  withFields(form, { base_url: "https://example.org/v1?api_key=value" });
  assert.throws(() => formRequest(form), /embedded credentials/);
  assert.ok(
    !displayField(
      form.fields.find((field) => field.key === "base_url"),
    ).includes("api_key=value"),
  );
  withFields(form, {
    base_url: "https://example.org/v1",
    credential_ref: "sk-do-not-echo-this",
  });
  assert.throws(() => formRequest(form), /env:VARIABLE_NAME/);
  assert.ok(
    !displayField(
      form.fields.find((field) => field.key === "credential_ref"),
    ).includes("sk-"),
  );
});

test("all role model IDs are explicit; validation commands remain argument arrays", () => {
  const model = withFields(createForm("model_profiles"), {
    id: "coding",
    activator_endpoint: "cloud",
    activator_model: "planner",
    primitive_endpoint: "local",
    primitive_model: "coder",
    diagnosis_endpoint: "cloud",
    diagnosis_model: "diagnosis",
  });
  assert.deepEqual(formRequest(model).value.primitive, {
    endpoint_id: "local",
    model: "coder",
  });
  const validation = withFields(createForm("validation_profiles"), {
    id: "checks",
  });
  const request = formRequest(validation);
  assert.equal(request.value.backend, "bwrap");
  assert.equal(request.value.network, "none");
  assert.ok(Array.isArray(request.value.checks[0].args));
  withFields(validation, { tools: JSON.stringify(["/opt/node"]) });
  assert.deepEqual(formRequest(validation).value.tools, ["/opt/node"]);
  withFields(validation, { tools: JSON.stringify(["../credentials"]) });
  assert.throws(() => formRequest(validation), /absolute paths/);
  withFields(validation, { tools: "[]" });
  withFields(validation, {
    checks: JSON.stringify([
      {
        id: "test",
        command: "node",
        args: "--test",
        required: true,
        timeout_seconds: 2,
      },
    ]),
  });
  assert.throws(() => formRequest(validation), /args must be an array/);
  withFields(validation, {
    checks: JSON.stringify([
      {
        id: "test",
        command: "node",
        args: [],
        required: false,
        timeout_seconds: 2,
      },
    ]),
  });
  assert.throws(() => formRequest(validation), /mandatory check/);
});

test("editing existing profiles preserves operator tool directories, workspace caps and credential references", () => {
  const validation = createForm("validation_profiles", "checks", {
    revision: "r1",
    tools: ["/opt/runtime"],
  });
  assert.deepEqual(formRequest(validation).value.tools, ["/opt/runtime"]);
  const workspace = createForm("workspaces", "repo", {
    revision: "r1",
    path: "/project",
    limits: { max_parallel: 1 },
  });
  assert.deepEqual(formRequest(workspace).value.limits, { max_parallel: 1 });
  const endpoint = createForm("endpoints", "endpoint", {
    revision: "r1",
    base_url: "https://example.org/v1",
    credential_ref: "file:/private/model-key",
  });
  assert.equal(
    formRequest(endpoint).value.credential_ref,
    "file:/private/model-key",
  );
  assert.equal(
    publicValue({ credential_ref: "file:/private/model-key" }).credential_ref,
    "file:/private/model-key",
  );
});

test("configuration saves use service data; revision conflicts preserve the editable draft", async () => {
  const calls = [];
  let reject = true;
  const controller = new PanelController({
    call: async (request) => {
      calls.push(request);
      if (request.action === "inspect")
        return inspection({
          endpoints: {
            local: { revision: "r1", base_url: "http://127.0.0.1:8080/v1" },
          },
        });
      if (request.action === "list_runs") return { ok: true, runs: [] };
      return reject
        ? {
            ok: false,
            error: {
              code: "REVISION_CONFLICT",
              message: "Bearer secret-provider-token",
            },
          }
        : { ok: true };
    },
  });
  await controller.refresh();
  controller.setPage("endpoints");
  await controller.key(key("return"));
  withFields(controller.state.modal.form, {
    base_url: "http://127.0.0.1:9999/v1",
  });
  await controller.save();
  assert.equal(calls.at(-1).expected_revision, "r1");
  assert.equal(controller.state.modal.kind, "form");
  assert.match(controller.state.modal.form.error, /REVISION_CONFLICT/);
  assert.equal(
    controller.state.modal.form.fields.find((field) => field.key === "base_url")
      .value,
    "http://127.0.0.1:9999/v1",
  );
  assert.ok(!controller.state.message.includes("secret-provider-token"));
  reject = false;
  await controller.save();
  assert.equal(controller.state.modal, null);
  assert.match(controller.state.message, /Saved local/);
});

test("inspection preserves numeric token budgets through workspace edits while masking secret token fields", async () => {
  const limits = {
    max_input_tokens: 50000,
    max_output_tokens: 10000,
    max_parallel: 2,
  };
  const controller = new PanelController({
    call: async (request) =>
      request.action === "inspect"
        ? inspection({
            workspaces: { repo: { revision: "r1", path: "/project", limits } },
          })
        : { ok: true, runs: [] },
  });
  await controller.refresh();
  controller.setPage("workspaces");
  await controller.key(key("return"));
  assert.deepEqual(
    formRequest(controller.state.modal.form).value.limits,
    limits,
  );
  assert.deepEqual(
    publicValue({
      input_tokens: 42,
      max_output_tokens: 100,
      token: "credential",
      access_token: "credential",
      output_tokens: "credential",
    }),
    {
      input_tokens: 42,
      max_output_tokens: 100,
      token: "[redacted]",
      access_token: "[redacted]",
      output_tokens: "[redacted]",
    },
  );
});

test("provisioning requests a credential file and never renders a returned plaintext credential", async () => {
  const calls = [];
  const controller = new PanelController({
    call: async (request) => {
      calls.push(request);
      if (request.action === "inspect")
        return inspection({
          clients: { harness: { principal: "owner", token: "do-not-display" } },
        });
      if (request.action === "list_runs") return { ok: true, runs: [] };
      return { ok: true, token: "one-time-secret" };
    },
  });
  controller.setPage("clients");
  await controller.key(key("n"));
  withFields(controller.state.modal.form, {
    id: "harness",
    principal: "owner",
    workspace_ids: "project",
    model_profile_ids: "coding",
    validation_profile_ids: "checks",
    output_file: "/tmp/client-credential.json",
  });
  await controller.save();
  const request = calls.find((call) => call.action === "provision_client");
  assert.equal(request.output_file, "/tmp/client-credential.json");
  const rendered = renderFrame(controller.state, 120, 40).lines.join("");
  assert.ok(!rendered.includes("one-time-secret"));
  assert.ok(!rendered.includes("do-not-display"));
  assert.equal(
    controller.state.configuration.clients.harness.token,
    "[redacted]",
  );
});

test("external text cannot emit terminal commands, secrets or unsafe OSC hyperlinks", () => {
  const poisoned = "\x1b]52;c;c2VjcmV0\x07hello\x1b[2J\u202eevil";
  assert.equal(safeText(poisoned), "hello evil");
  const value = publicValue({
    api_key: "raw-key",
    credential_ref: "raw-key",
    nested: { access_token: "token", secret: "secret" },
    base_url: "https://u:p@example.org/v1?key=value#secret",
    label: poisoned,
  });
  assert.equal(value.api_key, "[redacted]");
  assert.equal(value.credential_ref, "[redacted]");
  assert.equal(value.base_url, "https://example.org/v1");
  assert.equal(value.label, "hello evil");
  assert.ok(!JSON.stringify(value).includes("raw-key"));
});

test("Unicode graphemes use terminal cells; renderer emits only changed rows", () => {
  assert.equal(visibleWidth("測試"), 4);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.equal(visibleWidth("👩‍💻🇦🇹"), 4);
  assert.equal(visibleWidth(C.accent + "hi\x1b[0m"), 2);
  assert.equal(visibleWidth(tailCells("測試".repeat(10000), 15)), 14);
  const frames = [];
  const renderer = new Renderer({ write: (text) => frames.push(text) });
  renderer.frame(["a", "b"], { width: 80, height: 24 });
  renderer.frame(["a", "b"], { width: 80, height: 24 });
  assert.equal(frames.length, 1);
  renderer.frame(["a", "c"], { width: 80, height: 24 });
  assert.equal(frames.length, 2);
  assert.ok(!frames[1].includes("\x1b[1;1H"));
  assert.ok(frames[1].includes("\x1b[2;1H"));
});

test("UTF-8, split CRLF and SGR mouse survive fragmented terminal input; paste cannot become shortcuts", async () => {
  const keys = [],
    mice = [];
  const decoder = createInputDecoder(
    (value) => keys.push(value),
    (...value) => mice.push(value),
    10,
  );
  const encoded = Buffer.from("п");
  decoder.write(encoded.subarray(0, 1));
  decoder.write(encoded.subarray(1));
  decoder.write("\r");
  decoder.write("\n");
  decoder.write("\x1b[<0;");
  decoder.write("5;8M");
  decoder.write("\x1b[200~q\n");
  decoder.write("s\x1b[201~");
  assert.equal(keys[0].sequence, "п");
  assert.equal(keys.filter((item) => item.name === "return").length, 1);
  assert.deepEqual(mice[0], [0, 4, 7, false]);
  assert.equal(keys.at(-1).name, "paste");
  const controller = new PanelController({ call: async () => ({ ok: true }) });
  await controller.key(keys.at(-1));
  assert.equal(controller.state.closed, false);
  controller.setPage("endpoints");
  await controller.key(key("n"));
  await controller.key(keys.at(-1));
  assert.equal(controller.state.modal.form.fields[0].value, "q s");
  decoder.close();
});

test("terminal cleanup restores raw state and closes only the panel", async () => {
  class Input extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = true;
    isPaused() {
      return this.paused;
    }
    setRawMode(value) {
      this.isRaw = value;
    }
    resume() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
  }
  class Output extends EventEmitter {
    isTTY = true;
    columns = 80;
    rows = 24;
    writes = [];
    write(value) {
      this.writes.push(value);
    }
  }
  const input = new Input(),
    output = new Output(),
    calls = [];
  const promise = runTui({
    input,
    output,
    call: async (request) => {
      calls.push(request);
      return request.action === "inspect"
        ? inspection({})
        : { ok: true, runs: [] };
    },
  });
  input.emit("data", Buffer.from("\x03"));
  await promise;
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.ok(output.writes.at(-1).includes("\x1b[?1049l"));
  assert.ok(
    !calls.some((request) =>
      ["stop", "drain", "cancel"].includes(request.action),
    ),
  );
  await assert.rejects(
    runTui({
      call: async () => ({ ok: true }),
      input: { isTTY: false },
      output,
    }),
    { code: "TTY_REQUIRED" },
  );
});

test("drain/stop/revoke require a deliberate operator confirmation", async () => {
  const calls = [];
  const controller = new PanelController({
    call: async (request) => {
      calls.push(request);
      return request.action === "inspect" ? inspection({}) : { ok: true };
    },
  });
  controller.setPage("service");
  await controller.key(key("s"));
  assert.equal(calls.length, 0);
  await controller.key(key("n"));
  assert.equal(controller.state.modal, null);
  assert.equal(calls.length, 0);
  await controller.key(key("d"));
  await controller.key(key("y"));
  assert.ok(calls.some((request) => request.action === "drain"));
});
