import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { NativeSession } from "../dist/runtime/src/engine/native.js";
import {
  planSchema,
  diagnosisSchema,
} from "../dist/runtime/src/models/tools.js";
import { retrieval } from "../dist/runtime/src/controller/roles.js";
import { RunStore } from "../dist/runtime/src/storage/store.js";
import { DEFAULT_LIMITS, emptyUsage } from "../dist/runtime/src/types.js";
import { hash } from "../dist/runtime/src/util.js";

const binary = fileURLToPath(
  new URL(
    "../engine/jcode/modified/primitive/target/release/jcode-primitive" +
      (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
const state = { artifact_hash: null, artifact_version: 0, inbox_cursor: 0 };
const ajv = new Ajv2020({ strict: false });
async function session(t, role, dependencies = ["a.ts"]) {
  const native = new NativeSession(
    { binary, sha256: hash(readFileSync(binary)) },
    "schema-" + role,
    {
      run_id: "run",
      role,
      artifact_path: role === "primitive" ? "a.ts" : null,
      allowed_dependencies: dependencies,
      execution_generation: 1,
      policy_revision: "primitive-policy/1",
      max_tool_calls: 100,
      max_payload_bytes: 16777216,
    },
    new AbortController().signal,
  );
  t.after(() => native.close());
  assert.throws(() => native.tools, { code: "ENGINE_PROTOCOL_ERROR" });
  await native.initialize(state);
  const before = native.tools;
  before[0].function.name = "bash";
  assert.ok(native.tools.every((tool) => tool.function.name !== "bash"));
  return native;
}
const schemaFor = (native, name) =>
  ajv.compile(
    native.tools.find((tool) => tool.function.name === name).function
      .parameters,
  );

test(
  "plan text boundaries agree between the actual native catalog, authorization and host schema",
  { timeout: 10000 },
  async (t) => {
    const native = await session(t, "activator");
    const validate = schemaFor(native, "submit_plan");
    const value = {
      assignments: [
        { path: "a.ts", objective: "x".repeat(16384), dependencies: [] },
      ],
      summary: "s".repeat(16384),
    };
    const excess = structuredClone(value);
    excess.assignments[0].objective += "x";
    assert.equal(validate(excess), false);
    assert.equal(planSchema.safeParse(excess).success, false);
    await assert.rejects(native.authorize("too-long", "submit_plan", excess), {
      code: "INVALID_ARGUMENT",
    });
    assert.equal(validate(value), true);
    assert.equal(planSchema.safeParse(value).success, true);
    await native.authorize("at-limit", "submit_plan", value);
  },
);

test(
  "diagnosis array and text boundaries agree with the actual native schema",
  { timeout: 10000 },
  async (t) => {
    const native = await session(t, "diagnosis"),
      validate = schemaFor(native, "submit_diagnosis");
    const value = {
      verdict: "fail",
      summary: "s".repeat(16384),
      evidence: Array.from({ length: 256 }, (_, i) =>
        i ? "evidence " + i : "e".repeat(16384),
      ),
      causes: [{ path: "a.ts", reason: "r".repeat(16384) }],
      guidance: [{ path: "a.ts", objective: "o".repeat(16384) }],
    };
    const excess = { ...value, evidence: [...value.evidence, "additional"] };
    assert.equal(validate(excess), false);
    assert.equal(diagnosisSchema.safeParse(excess).success, false);
    await assert.rejects(
      native.authorize("too-many", "submit_diagnosis", excess),
      { code: "INVALID_ARGUMENT" },
    );
    assert.equal(validate(value), true);
    assert.equal(diagnosisSchema.safeParse(value).success, true);
    await native.authorize("at-limit", "submit_diagnosis", value);
  },
);

test(
  "search accepts the advertised ASCII boundary and enforces the shared UTF-8 byte ceiling",
  { timeout: 10000 },
  async (t) => {
    const native = await session(t, "activator", []),
      validate = schemaFor(native, "search");
    const ctx = {
      signal: new AbortController().signal,
      store: { active() {} },
      runId: "run",
      generation: 1,
    };
    for (const [id, query] of [
      ["ascii", "x".repeat(1024)],
      ["utf8", "界".repeat(341) + "x"],
    ]) {
      assert.equal(validate({ query }), true);
      await native.authorize(id, "search", { query });
      assert.deepEqual(
        (await retrieval(ctx, "/unused", [], "search", { query })).matches,
        [],
      );
      await native.complete(id, { matches: [] }, false, state);
    }
    await assert.rejects(
      native.authorize("excess", "search", { query: "x".repeat(1025) }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      retrieval(ctx, "/unused", [], "search", { query: "界".repeat(342) }),
      { code: "INVALID_ARGUMENT" },
    );
  },
);

test(
  "message payload limit agrees across the native catalog, authorization and durable store",
  { timeout: 10000 },
  async (t) => {
    const native = await session(t, "primitive", ["b.ts"]),
      validate = schemaFor(native, "send_message");
    const directory = mkdtempSync(join(tmpdir(), "primitive-schema-")),
      store = new RunStore(directory);
    t.after(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const now = new Date().toISOString();
    store.insertRun({
      run_id: "run",
      principal: "owner",
      tool_binding: "test",
      client_id: "client",
      request_digest: "digest",
      request: {
        action: "start",
        client_request_id: "id",
        workspace_id: "workspace",
        task: "schema test",
      },
      resolved: { limits: DEFAULT_LIMITS },
      state: "running",
      phase: "collaborating",
      verification: "not_run",
      application: "not_applicable",
      generation: 1,
      cancel_requested: false,
      created_at: now,
      updated_at: now,
      finished_at: null,
      round_index: 0,
      usage: emptyUsage(),
      result: null,
      error: null,
    });
    for (const id of ["a", "b"])
      store.savePrimitive({
        primitive_id: id,
        run_id: "run",
        artifact_id: id,
        canonical_path: id + ".ts",
        base_hash: null,
        current_hash: null,
        artifact_version: 0,
        objective: "schema test",
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
    const value = {
        recipient_id: "b",
        type: "interface",
        payload: "x".repeat(16384),
      },
      excess = { ...value, payload: value.payload + "x" };
    assert.equal(validate(excess), false);
    await assert.rejects(
      native.authorize("too-large", "send_message", excess),
      { code: "INVALID_ARGUMENT" },
    );
    assert.equal(validate(value), true);
    await native.authorize("at-limit", "send_message", value);
    const message = store.send(
      "run",
      1,
      "a",
      "b",
      value.type,
      value.payload,
      "message",
    );
    assert.equal(message.payload, value.payload);
    assert.equal(store.inbox("run", "b", 0)[0].payload, value.payload);
  },
);
