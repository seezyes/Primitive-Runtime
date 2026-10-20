import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  harness,
  start,
  terminal,
  tool,
  git,
  until,
  FIXTURE_FILES,
} from "./fixtures/runtime-harness.mjs";
import { PEER_MESSAGE } from "./fixtures/scripted-provider.mjs";

const linux = {
  skip: process.platform !== "linux" || process.arch !== "x64",
  timeout: 120000,
};

test(
  "standalone MCP, native JCode and bwrap complete a literal in-round interface change",
  linux,
  async (t) => {
    const h = await harness(t);
    const catalog = await h.client.listTools();
    assert.deepEqual(
      catalog.tools.map((tool) => tool.name),
      ["primitive_runtime"],
    );
    assert.equal(catalog.tools[0].inputSchema.type, "object");
    const capabilities = await tool(h.client, { action: "capabilities" });
    assert.equal(capabilities.capabilities.approved_apply_v1, false);
    assert.deepEqual(capabilities.mcp_versions, ["2025-06-18"]);
    const id = await start(h, "cooperate-interface", {
      limits: { max_revisions: 0 },
    });
    const { result, events } = await terminal(h, id);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result));
    assert.equal(result.run.verification, "passed");
    assert.equal(result.run.application, "staged");
    assert.equal(result.rounds_used, 1);
    assert.deepEqual(result.candidate.files_changed, [
      "a-consumer.cjs",
      "z-producer.cjs",
    ]);
    assert.equal(result.validation[0].status, "passed");
    assert.equal(
      result.validation[0].candidate_hash,
      result.candidate.candidate_hash,
    );
    assert.equal(result.usage.cost_usd, null);
    for (const role of ["activator", "primitive", "diagnosis"])
      assert.ok(result.usage.by_role[role].calls > 0);
    assert.deepEqual(h.provider.errors, []);
    const incorporated = h.provider.calls
      .flatMap((call) => call.messages)
      .filter((message) => message.role === "user")
      .map((message) => {
        try {
          return JSON.parse(message.content);
        } catch {
          return null;
        }
      })
      .find(
        (context) =>
          context?.artifact === "a-consumer.cjs" && context.messages?.length,
      );
    assert.equal(incorporated.messages[0].payload, PEER_MESSAGE);
    const message = events.find((event) => event.type === "message_delivered");
    const consumerPatch = events.find(
      (event) =>
        event.type === "patch_staged" &&
        event.payload.path === "a-consumer.cjs",
    );
    const validation = events.find(
      (event) =>
        event.type === "phase_changed" && event.payload.phase === "validating",
    );
    assert.ok(Number(message.event_id) < Number(consumerPatch.event_id));
    assert.ok(Number(consumerPatch.event_id) < Number(validation.event_id));
    const db = new DatabaseSync(path.join(h.state, "runtime.sqlite"), {
      readOnly: true,
    });
    try {
      const consumer = JSON.parse(
        db
          .prepare("SELECT data FROM primitives WHERE run_id=? AND path=?")
          .get(id, "a-consumer.cjs").data,
      );
      assert.equal(consumer.conversation.core.format, "jcode-turn/1");
      const finishes = consumer.conversation.core.messages
        .flatMap((message) => message.content)
        .filter(
          (block) => block.type === "tool_use" && block.name === "finish",
        );
      assert.equal(
        finishes.length,
        2,
        "A finished consumer must run again after the producer message",
      );
      assert.equal(consumer.inbox_cursor, 1);
      assert.equal(consumer.artifact_version, 1);
    } finally {
      db.close();
    }
    const diff = await tool(h.client, {
      action: "artifact",
      run_id: id,
      artifact_id: result.candidate.diff_artifact_id,
    });
    const patch = Buffer.from(diff.artifact.content, "base64").toString();
    assert.match(patch, /a-consumer\.cjs/);
    assert.match(patch, /z-producer\.cjs/);
    const evidence = await tool(h.client, {
      action: "artifact",
      run_id: id,
      artifact_id: result.validation[0].output_artifact_id,
    });
    assert.match(
      Buffer.from(evidence.artifact.content, "base64").toString(),
      /VERIFIED_BEHAVIOR_42/,
    );
    const patchFile = path.join(h.directory, "result.patch");
    await fs.writeFile(patchFile, patch);
    git(h.source, ["apply", "--check", patchFile]);
    for (const [file, content] of Object.entries(FIXTURE_FILES))
      assert.equal(
        await fs.readFile(path.join(h.source, file), "utf8"),
        content,
      );
    assert.equal(git(h.source, ["status", "--porcelain"]), "");
  },
);

test(
  "three additional revisions permit exactly four candidates and preserve prior sessions",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "repair-on-fourth", {
      limits: { max_revisions: 3 },
    });
    const { result, events } = await terminal(h, id);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result));
    assert.equal(result.rounds_used, 4);
    assert.equal(h.provider.activations.get("repair-on-fourth"), 4);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "phase_changed" &&
          event.payload.phase === "validating",
      ).length,
      4,
    );
    assert.equal(result.validation[0].status, "passed");
    assert.equal(
      await fs.readFile(path.join(h.source, "z-producer.cjs"), "utf8"),
      FIXTURE_FILES["z-producer.cjs"],
    );
  },
);

test(
  "max_revisions=0 validates one candidate and model PASS cannot override a failed check",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "never-fix", { limits: { max_revisions: 0 } });
    const { result } = await terminal(h, id);
    assert.equal(
      result.ok,
      true,
      "Looking up a failed run is a successful tool operation",
    );
    assert.equal(result.run.state, "failed", JSON.stringify(result));
    assert.equal(result.run.verification, "failed");
    assert.equal(result.diagnosis.verdict, "pass");
    assert.equal(result.validation[0].status, "failed");
    assert.equal(result.rounds_used, 1);
    assert.equal(h.provider.activations.get("never-fix"), 1);
    assert.equal(result.error.code, "REVISION_BUDGET_EXHAUSTED");
  },
);

test(
  "external workspace edits are reported as conflicts and are never overwritten",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "conflict-repair");
    const held = await until(
      () => h.provider.held.find((item) => item.task === "conflict-repair"),
      "primitive model request",
    );
    const external = "exports.value=()=>777; // external user edit\n";
    await fs.writeFile(path.join(h.source, "z-producer.cjs"), external);
    held.release();
    const { result } = await terminal(h, id);
    assert.equal(result.run.state, "failed", JSON.stringify(result));
    assert.equal(result.run.application, "conflict");
    assert.equal(result.error.code, "WORKSPACE_CONFLICT");
    assert.equal(
      await fs.readFile(path.join(h.source, "z-producer.cjs"), "utf8"),
      external,
    );
    assert.equal(result.run.verification, "not_run");
  },
);

test(
  "unavailable isolation rejects verification before any model work",
  linux,
  async (t) => {
    const h = await harness(t, {
      serviceEnv: { PATH: "/nonexistent-primitive-tools" },
    });
    const id = await start(h, "missing-sandbox");
    const { result } = await terminal(h, id);
    assert.equal(result.run.state, "failed");
    assert.equal(result.run.verification, "unverified");
    assert.equal(result.error.code, "UNSUPPORTED_SANDBOX");
    assert.equal(h.provider.calls.length, 0);
  },
);

test(
  "operator cannot remove every mandatory check or enable a model-supplied apply action",
  linux,
  async (t) => {
    const h = await harness(t);
    const invalid = await h.control({
      action: "upsert_validation_profile",
      id: "checks",
      expected_revision: "checks-1",
      value: {
        ...h.config.validation_profiles.checks,
        checks: [
          { ...h.config.validation_profiles.checks.checks[0], required: false },
        ],
      },
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "INVALID_ARGUMENT");
    const apply = await tool(h.client, {
      action: "start",
      client_request_id: "cannot-apply",
      workspace_id: "fixture",
      task: "repair",
      mode: "apply",
      approved: true,
    });
    assert.equal(apply.ok, false);
    assert.equal(apply.error.code, "INVALID_ARGUMENT");
    assert.equal(h.provider.calls.length, 0);
  },
);
