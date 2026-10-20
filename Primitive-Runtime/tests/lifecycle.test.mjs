import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { requestLocal } from "../dist/runtime/src/control/ipc.js";
import { CONTRACT_VERSION } from "../dist/runtime/src/contracts.js";
import { ACTIONS } from "../dist/runtime/src/types.js";
import {
  harness,
  start,
  terminal,
  tool,
  until,
  stopped,
  children,
  FIXTURE_FILES,
} from "./fixtures/runtime-harness.mjs";

const linux = {
  skip: process.platform !== "linux" || process.arch !== "x64",
  timeout: 120000,
};

async function descendants(pid) {
  const direct = await children(pid);
  return [...direct, ...(await Promise.all(direct.map(descendants))).flat()];
}

async function command(pid) {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function nativeWorkers(h) {
  const pids = await children(h.service.pid);
  return (
    await Promise.all(
      pids.map(async (pid) => ({ pid, args: await command(pid) })),
    )
  ).filter((item) => item.args[0]?.endsWith("/jcode-primitive"));
}

function readRun(h, id) {
  const db = new DatabaseSync(path.join(h.state, "runtime.sqlite"), {
    readOnly: true,
  });
  try {
    return JSON.parse(
      db.prepare("SELECT data FROM runs WHERE id=?").get(id).data,
    );
  } finally {
    db.close();
  }
}

async function provision(h, id, principal, binding, actions = [...ACTIONS]) {
  const file = path.join(h.directory, id + ".json");
  const response = await h.control({
    action: "provision_client",
    id,
    value: {
      principal,
      tool_binding: binding,
      workspace_ids: ["fixture"],
      model_profile_ids: ["coding"],
      validation_profile_ids: ["checks"],
      actions,
    },
    output_file: file,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return {
    client: await h.connect(file),
    credential: JSON.parse(await fs.readFile(file, "utf8")),
    revision: response.revision,
  };
}

test(
  "an accepted run survives closing the MCP stdio pipe and remains pollable from a new adapter",
  linux,
  async (t) => {
    const h = await harness(t);
    const servicePid = h.service.pid;
    const id = await start(h, "hold-repair-pipe", {
      limits: { max_revisions: 0 },
    });
    const held = await until(
      () => h.provider.held.find((item) => item.task === "hold-repair-pipe"),
      "pending primitive request",
    );
    const workers = await nativeWorkers(h);
    assert.equal(
      workers.length,
      1,
      "The primitive must be held behind a real native policy session",
    );
    await h.client.close();
    assert.equal(await stopped(servicePid), false);
    assert.equal(
      held.aborted,
      false,
      "Transport disconnect must not cancel accepted work",
    );
    const replacement = await h.connect();
    const pending = await tool(replacement, { action: "status", run_id: id });
    assert.equal(pending.run.state, "running");
    held.release();
    const { result } = await terminal(h, id, replacement);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result));
    assert.equal(
      h.service.pid,
      servicePid,
      "The durable service is independent of the MCP adapter",
    );
    assert.equal(h.provider.activations.get("hold-repair-pipe"), 1);
  },
);

test(
  "a lost start response is recovered through a new MCP adapter without a second run or activation",
  linux,
  async (t) => {
    const h = await harness(t);
    await h.client.close();
    const request = {
      action: "start",
      client_request_id: "lost-start-response",
      workspace_id: "fixture",
      task: "hold-repair-lost-start-response",
      limits: { max_revisions: 0 },
    };
    await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: h.credential.socket_path,
          path: "/tool",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + h.credential.token,
            "x-primitive-contract": CONTRACT_VERSION,
          },
          timeout: 10000,
          agent: false,
        },
        (response) => {
          // Deliberately discard the real response before reading any JSON or
          // learning the run handle. The accepted run is already durable.
          const status = response.statusCode;
          const bodyWasRead = response.readableDidRead;
          response.destroy();
          req.destroy();
          if (status !== 200 || bodyWasRead)
            reject(
              new Error(
                "Lost-response fixture did not discard a successful unread response",
              ),
            );
          else resolve();
        },
      );
      req.once("error", reject);
      req.once("timeout", () =>
        req.destroy(new Error("Lost-response request timed out")),
      );
      req.end(JSON.stringify(request));
    });
    const persistedRuns = () => {
      const db = new DatabaseSync(path.join(h.state, "runtime.sqlite"), {
        readOnly: true,
      });
      try {
        return db.prepare("SELECT id FROM runs").all();
      } finally {
        db.close();
      }
    };
    const beforeRetry = persistedRuns();
    assert.equal(
      beforeRetry.length,
      1,
      "The unread reply must follow durable admission",
    );
    const held = await until(
      () => h.provider.held.find((item) => item.task === request.task),
      "accepted primitive after its start reply was discarded",
    );
    assert.equal(h.provider.activations.get(request.task), 1);
    const callsBeforeRetry = h.provider.calls.length;
    const replacement = await h.connect();
    const recovered = await tool(replacement, request);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.idempotent_replay, true);
    assert.equal(recovered.run.run_id, beforeRetry[0].id);
    assert.equal(h.provider.calls.length, callsBeforeRetry);
    assert.equal(held.aborted, false);
    assert.deepEqual(persistedRuns(), beforeRetry);
    held.release();
    const { result } = await terminal(h, recovered.run.run_id, replacement);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result));
    assert.equal(h.provider.activations.get(request.task), 1);
    assert.deepEqual(persistedRuns(), beforeRetry);
  },
);

test(
  "idempotency uses explicit arguments and the original snapshot after operator defaults change",
  linux,
  async (t) => {
    const h = await harness(t, {
      configure(config) {
        config.model_profiles.alternate = {
          ...structuredClone(config.model_profiles.coding),
          revision: "alternate-1",
        };
      },
    });
    const request = {
      action: "start",
      client_request_id: "idempotent-request",
      workspace_id: "fixture",
      task: "repair-idempotent",
      limits: { max_revisions: 0 },
    };
    const accepted = await tool(h.client, request);
    assert.equal(accepted.ok, true);
    const id = accepted.run.run_id;
    const { result: before } = await terminal(h, id);
    assert.equal(before.run.state, "succeeded", JSON.stringify(before));
    const original = readRun(h, id);
    const changed = await h.control({
      action: "upsert_workspace",
      id: "fixture",
      expected_revision: "workspace-1",
      value: {
        ...h.config.workspaces.fixture,
        default_model_profile_id: "alternate",
        limits: { max_revisions: 0 },
      },
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const calls = h.provider.calls.length;
    const replay = await tool(h.client, request);
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.run.run_id, id);
    assert.equal(h.provider.calls.length, calls);
    assert.deepEqual(readRun(h, id).resolved, original.resolved);
    assert.equal(original.resolved.model_profile_id, "coding");
    const conflict = await tool(h.client, {
      ...request,
      task: "a different task",
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  },
);

test(
  "principal, tool binding, action scope and revocation fence every run and artifact lookup",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "repair-auth", { limits: { max_revisions: 0 } });
    const { result } = await terminal(h, id);
    assert.equal(result.run.state, "succeeded", JSON.stringify(result));
    const artifact = result.candidate.diff_artifact_id;
    const bob = await provision(h, "bob", "bob", "main");
    const otherBinding = await provision(h, "other-binding", "alice", "other");
    const capabilityOnly = await provision(
      h,
      "capability-only",
      "alice",
      "main",
      ["capabilities"],
    );
    for (const actor of [bob, otherBinding, capabilityOnly]) {
      for (const request of [
        { action: "status", run_id: id },
        { action: "result", run_id: id },
        { action: "artifact", run_id: id, artifact_id: artifact },
        { action: "cancel", run_id: id },
      ]) {
        const denied = await tool(actor.client, request);
        assert.equal(denied.ok, false);
        assert.equal(denied.error.code, "ACCESS_DENIED");
        assert.equal(
          denied.run,
          undefined,
          "Denied reads must not disclose run state",
        );
        assert.equal(
          denied.artifact,
          undefined,
          "Denied reads must not disclose artifact bytes",
        );
      }
      const deniedControl = await requestLocal(actor.credential, "/control", {
        action: "inspect",
      });
      assert.equal(deniedControl.ok, false);
      assert.equal(deniedControl.error.code, "ACCESS_DENIED");
    }
    const alias = await provision(h, "same-authority", "alice", "main");
    const allowed = await tool(alias.client, {
      action: "artifact",
      run_id: id,
      artifact_id: artifact,
      offset: 1,
      max_bytes: 11,
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    const revoked = await h.control({
      action: "revoke_client",
      id: "same-authority",
      expected_revision: alias.revision,
    });
    assert.equal(revoked.ok, true);
    const denied = await tool(alias.client, { action: "status", run_id: id });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "ACCESS_DENIED");
    const stillReadable = await tool(h.client, {
      action: "result",
      run_id: id,
    });
    assert.equal(stillReadable.run.state, "succeeded");
  },
);

test(
  "cancellation aborts an actual model connection and waits for the native process to exit",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "hold-cancel-model");
    const held = await until(
      () => h.provider.held.find((item) => item.task === "hold-cancel-model"),
      "model request to cancel",
    );
    const workers = await nativeWorkers(h);
    assert.equal(workers.length, 1);
    const cancelled = await tool(h.client, { action: "cancel", run_id: id });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.run.state, "cancelled");
    for (const { pid } of workers)
      assert.equal(
        await stopped(pid),
        true,
        "Cancel acknowledgment follows native process exit",
      );
    await until(() => held.aborted, "HTTP model transport cancellation");
    const { result, events } = await terminal(h, id);
    assert.equal(result.run.state, "cancelled");
    assert.equal(result.error.code, "CANCELLED");
    assert.equal(result.candidate, null);
    assert.equal(
      result.usage.estimated_output_tokens,
      4096,
      "An interrupted billed request is not recorded as free",
    );
    assert.equal(
      events.filter((event) => event.type === "cancel_requested").length,
      1,
    );
    const repeated = await tool(h.client, { action: "cancel", run_id: id });
    assert.equal(repeated.run.state, "cancelled");
    assert.equal(await stopped(h.service.pid), false);
    assert.equal(
      await fs.readFile(path.join(h.source, "z-producer.cjs"), "utf8"),
      FIXTURE_FILES["z-producer.cjs"],
    );
  },
);

test(
  "cancellation kills a running sandbox process tree before the terminal response",
  linux,
  async (t) => {
    const h = await harness(t, {
      files: {
        "check.cjs":
          "console.log('VALIDATION_RUNNING');\nsetInterval(()=>{},1000);\n",
      },
    });
    const id = await start(h, "repair-cancel-validation");
    const worker = await until(async () => {
      for (const pid of await descendants(h.service.pid)) {
        const args = await command(pid);
        if (args[0] === process.execPath && args.includes("check.cjs"))
          return pid;
      }
      return undefined;
    }, "actual validation Node process");
    const owned = await descendants(h.service.pid);
    assert.ok(owned.includes(worker));
    const status = await tool(h.client, { action: "status", run_id: id });
    assert.equal(status.run.phase, "validating");
    const response = await tool(h.client, { action: "cancel", run_id: id });
    assert.equal(response.ok, true);
    assert.equal(response.run.state, "cancelled", JSON.stringify(response));
    for (const pid of owned)
      await until(() => stopped(pid), "sandbox process cleanup " + pid);
    const { result } = await terminal(h, id);
    assert.equal(result.error.code, "CANCELLED");
    assert.notEqual(result.run.verification, "passed");
    assert.ok(
      result.candidate,
      "A cancelled validation preserves its inspectable frozen candidate",
    );
    const artifact = await tool(h.client, {
      action: "artifact",
      run_id: id,
      artifact_id: result.candidate.diff_artifact_id,
    });
    assert.equal(artifact.ok, true);
    assert.equal(await stopped(h.service.pid), false);
  },
);

test(
  "service crash fences abandoned generations while previous terminal results stay readable",
  linux,
  async (t) => {
    const h = await harness(t);
    const completeId = await start(h, "repair-before-restart", {
      limits: { max_revisions: 0 },
    });
    const { result: completeBefore } = await terminal(h, completeId);
    assert.equal(
      completeBefore.run.state,
      "succeeded",
      JSON.stringify(completeBefore),
    );
    const id = await start(h, "crash-model");
    const held = await until(
      () => h.provider.held.find((item) => item.task === "crash-model"),
      "request before service crash",
    );
    const before = readRun(h, id);
    const workers = await nativeWorkers(h);
    assert.equal(workers.length, 1);
    const oldPid = h.service.pid;
    await h.stopService("SIGKILL");
    await until(() => held.aborted, "crashed service model connection closed");
    for (const { pid } of workers)
      await until(() => stopped(pid), "orphaned native process exit");
    await h.startService();
    assert.notEqual(h.service.pid, oldPid);
    const after = readRun(h, id);
    assert.equal(after.generation, before.generation + 1);
    const { result } = await terminal(h, id);
    assert.equal(result.run.state, "interrupted");
    assert.equal(result.error.code, "SERVICE_RESTARTED");
    const completeAfter = await tool(h.client, {
      action: "result",
      run_id: completeId,
    });
    assert.deepEqual(completeAfter, completeBefore);
    const artifact = await tool(h.client, {
      action: "artifact",
      run_id: completeId,
      artifact_id: completeAfter.candidate.diff_artifact_id,
    });
    assert.equal(artifact.ok, true);
    const calls = h.provider.calls.length;
    const replay = await tool(h.client, {
      action: "start",
      client_request_id: "crash-model",
      workspace_id: "fixture",
      task: "crash-model",
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.run.run_id, id);
    assert.equal(replay.run.state, "interrupted");
    assert.equal(replay.idempotent_replay, true);
    assert.equal(
      h.provider.calls.length,
      calls,
      "An abandoned run must never silently resume model work",
    );
  },
);

test(
  "wall-time expiration keeps its timeout cause while native and model work are stopped",
  linux,
  async (t) => {
    const h = await harness(t);
    const id = await start(h, "hold-timeout", {
      limits: { max_wall_time_seconds: 4 },
    });
    const held = await until(
      () => h.provider.held.find((item) => item.task === "hold-timeout"),
      "model request before wall-time budget",
      8000,
    );
    const workers = await nativeWorkers(h);
    assert.equal(workers.length, 1);
    const { result } = await terminal(h, id);
    assert.equal(result.run.state, "failed");
    assert.equal(result.run.cancel_requested, false);
    assert.equal(result.error.code, "TIMEOUT", JSON.stringify(result));
    await until(() => held.aborted, "timed out model connection");
    for (const { pid } of workers) assert.equal(await stopped(pid), true);
  },
);
