import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import {
  Configuration,
  createOperatorConfig,
} from "../dist/runtime/src/control/config.js";
import { acquireStateLock } from "../dist/runtime/src/control/state-lock.js";
import { RuntimeService } from "../dist/runtime/src/service.js";
import {
  atomicJSON,
  canonical,
  hash,
  identifier,
} from "../dist/runtime/src/util.js";
import { ACTIONS, emptyUsage } from "../dist/runtime/src/types.js";
import {
  makeReadonly,
  removeTree,
} from "../dist/runtime/src/workspace/manifest.js";
import { uninstallRuntime } from "../scripts/lib/state.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "dist/runtime/src/cli.js");
const LOCK_MODULE = new URL(
  "../dist/runtime/src/control/state-lock.js",
  import.meta.url,
).href;
const SERVICE_MODULE = new URL(
  "../dist/runtime/src/service.js",
  import.meta.url,
).href;
const IPC_MODULE = new URL(
  "../dist/runtime/src/control/ipc.js",
  import.meta.url,
).href;
const ERROR_MODULE = new URL("../dist/runtime/src/errors.js", import.meta.url)
  .href;
const MARKER = ".primitive-runtime-state.json";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function bounded(promise, description, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out: " + description)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
function processRun(fixture, args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    ...options,
  });
  fixture.children.push(child);
  let stdout = "",
    stderr = "";
  child.stdout?.on("data", (value) => {
    stdout += value;
  });
  child.stderr?.on("data", (value) => {
    stderr += value;
  });
  const pending = [],
    messages = [];
  child.on("message", (value) =>
    pending.length ? pending.shift().resolve(value) : messages.push(value),
  );
  child.on("error", (error) => {
    for (const waiting of pending.splice(0)) waiting.reject(error);
  });
  const completion = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      for (const waiting of pending.splice(0))
        waiting.reject(new Error("Child exited before IPC result: " + stderr));
      resolve({ code, signal, stdout, stderr });
    }),
  );
  return {
    child,
    completion,
    message() {
      if (messages.length) return Promise.resolve(messages.shift());
      return bounded(
        new Promise((resolve, reject) => pending.push({ resolve, reject })),
        "child IPC",
      );
    },
  };
}
function lockProcess(fixture, options = {}) {
  const program = `
    import { acquireStateLock } from ${JSON.stringify(LOCK_MODULE)};
    const {directory, allowDeleting} = JSON.parse(process.argv[1]);
    try {
      const release = acquireStateLock(directory, {allowDeleting});
      process.send({ok:true,pid:process.pid});
      process.once('message', () => {
        release(); release();
        process.send({released:true}, () => process.disconnect());
      });
    } catch (error) {
      process.send({ok:false,code:error.code}, () => process.disconnect());
    }
  `;
  return processRun(fixture, [
    "--input-type=module",
    "-e",
    program,
    JSON.stringify({ directory: fixture.state, ...options }),
  ]);
}
async function releaseOwner(owner) {
  owner.child.send("release");
  assert.deepEqual(await owner.message(), { released: true });
  await bounded(owner.completion, "owner release exit");
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pr-maint-"));
  const state = join(directory, "state");
  const binary = join(directory, "explicitly-unavailable-test-engine");
  writeFileSync(
    binary,
    "No executable engine is needed by these maintenance tests.",
  );
  const locations = createOperatorConfig(state, binary);
  const f = {
    directory,
    state,
    ...locations,
    children: [],
    service: null,
    serviceClosed: false,
  };
  f.closeService = async () => {
    if (!f.service || f.serviceClosed) return;
    f.serviceClosed = true;
    await f.service.close();
  };
  t.after(async () => {
    for (const child of f.children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all(
      f.children.map((child) => bounded(exited(child), "test child cleanup")),
    );
    await f.closeService();
    await removeTree(directory);
  });
  return f;
}
async function configuredService(t, endpointURL = "http://127.0.0.1:1/v1") {
  const f = fixture(t);
  const source = join(f.directory, "source");
  mkdirSync(source);
  const route = { endpoint_id: "fixture", model: "opaque-model-id" };
  const c = JSON.parse(readFileSync(f.config_file, "utf8"));
  c.limits.max_provider_retries = 0;
  c.endpoints.fixture = {
    revision: "endpoint-1",
    protocol: "openai-chat-completions",
    base_url: endpointURL,
  };
  c.model_profiles.coding = {
    revision: "model-1",
    activator: route,
    primitive: route,
    diagnosis: route,
  };
  c.validation_profiles.checks = {
    revision: "checks-1",
    backend: "bwrap",
    network: "none",
    checks: [
      {
        id: "test",
        command: "/usr/bin/true",
        args: [],
        required: true,
        timeout_seconds: 1,
      },
    ],
    limits: {
      memory_mb: 64,
      cpu_seconds: 1,
      pids: 16,
      max_output_bytes: 1024,
      max_disk_mb: 1,
    },
  };
  c.workspaces.source = {
    revision: "workspace-1",
    path: source,
    default_model_profile_id: "coding",
    default_validation_profile_id: "checks",
  };
  atomicJSON(f.config_file, c);
  const config = new Configuration(f.config_file);
  f.service = new RuntimeService(config);
  await f.service.initialize();
  const actor = {
    client_id: "fixture",
    principal: "alice",
    tool_binding: "main",
    workspace_ids: ["source", "alias"],
    model_profile_ids: ["coding"],
    validation_profile_ids: ["checks"],
    actions: ACTIONS,
  };
  function runRecord(workspace_id = "source", changes = {}) {
    const request = {
      action: "start",
      client_request_id: identifier("request"),
      workspace_id,
      task: "maintenance fixture",
    };
    const now = new Date().toISOString();
    return {
      run_id: identifier("pr_run"),
      principal: actor.principal,
      tool_binding: actor.tool_binding,
      client_id: actor.client_id,
      request,
      request_digest: hash(canonical(request)),
      resolved: config.resolve(actor, request),
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
      ...changes,
    };
  }
  return Object.assign(f, { source, config, actor, runRecord });
}

test(
  "state ownership excludes other processes even with a stale diagnostic PID",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      owner = lockProcess(f);
    assert.equal((await owner.message()).ok, true);
    const contender = lockProcess(f);
    assert.deepEqual(await contender.message(), {
      ok: false,
      code: "SERVICE_RUNNING",
    });
    await contender.completion;
    writeFileSync(join(f.state, "service.lock"), "999999999", { mode: 0o600 });
    const stalePIDContender = lockProcess(f);
    assert.deepEqual(await stalePIDContender.message(), {
      ok: false,
      code: "SERVICE_RUNNING",
    });
    await stalePIDContender.completion;
    await releaseOwner(owner);
    const next = lockProcess(f);
    assert.equal(
      (await next.message()).ok,
      true,
      "a stale PID must not block a genuinely released SQLite owner",
    );
    await releaseOwner(next);
  },
);

test(
  "SIGKILL releases the OS ownership fence without trusting or deleting a stale PID",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      owner = lockProcess(f);
    const acquired = await owner.message();
    assert.equal(acquired.ok, true);
    owner.child.kill("SIGKILL");
    await bounded(owner.completion, "crashed owner exit");
    assert.equal(
      readFileSync(join(f.state, "service.lock"), "utf8"),
      String(acquired.pid),
    );
    const recovered = lockProcess(f);
    assert.equal((await recovered.message()).ok, true);
    await releaseOwner(recovered);
  },
);

test(
  "deleting marker denies ordinary ownership and CLI doctor but permits resumable uninstall",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    const marker = JSON.parse(readFileSync(join(f.state, MARKER), "utf8"));
    atomicJSON(join(f.state, MARKER), { ...marker, state: "deleting" });
    assert.throws(() => acquireStateLock(f.state), { code: "CONFIG_REQUIRED" });
    const doctor = await processRun(f, [
      CLI,
      "doctor",
      "--config",
      f.config_file,
    ]).completion;
    assert.equal(doctor.code, 1);
    assert.match(doctor.stderr, /"code":"CONFIG_REQUIRED"/);
    const serving = await processRun(f, [
      CLI,
      "serve",
      "--config",
      f.config_file,
    ]).completion;
    assert.equal(serving.code, 1);
    assert.match(serving.stderr, /"code":"CONFIG_REQUIRED"/);
    const resume = lockProcess(f, { allowDeleting: true });
    assert.equal((await resume.message()).ok, true);
    await releaseOwner(resume);
    // An interrupted uninstall may have already removed its operator config.
    fs.unlinkSync(f.config_file);
    const result = await uninstallRuntime(f.state);
    assert.equal(result.removed, true);
    assert.equal(existsSync(f.state), false);
  },
);

test(
  "offline doctor participates in the same multiprocess ownership fence",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      owner = lockProcess(f);
    assert.equal((await owner.message()).ok, true);
    const blocked = await processRun(f, [
      CLI,
      "doctor",
      "--config",
      f.config_file,
    ]).completion;
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /"code":"SERVICE_RUNNING"/);
    assert.equal(blocked.stdout, "");
    await releaseOwner(owner);
    const report = await processRun(f, [
      CLI,
      "doctor",
      "--config",
      f.config_file,
    ]).completion;
    assert.equal(
      report.code,
      1,
      "the intentionally non-executable test engine cannot report ready",
    );
    assert.equal(JSON.parse(report.stdout).ready, false);
    const next = lockProcess(f);
    assert.equal(
      (await next.message()).ok,
      true,
      "doctor must release ownership even when its readiness result is negative",
    );
    await releaseOwner(next);
  },
);

test("workspace aliases cannot admit a second active run against the same physical directory", async (t) => {
  const f = await configuredService(t);
  const alias = join(f.directory, "alias");
  symlinkSync(
    f.source,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  f.config.upsert("workspace", "alias", null, {
    path: alias,
    default_model_profile_id: "coding",
    default_validation_profile_id: "checks",
  });
  const active = f.runRecord();
  f.service.store.insertRun(active);
  const response = await f.service.action(f.actor, {
    action: "start",
    client_request_id: "alias-attempt",
    workspace_id: "alias",
    task: "must not execute",
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "WORKSPACE_BUSY");
  assert.equal(f.service.store.allRuns().length, 1);
  assert.equal(
    f.service.controller.activeCount,
    0,
    "the rejected alias cannot launch a worker",
  );
});

test("retention removes a read-only candidate before expiring payloads and preserves idempotency", async (t) => {
  const f = await configuredService(t);
  const old = f.runRecord("source", {
    state: "succeeded",
    phase: null,
    finished_at: "2020-01-01T00:00:00Z",
    verification: "passed",
  });
  f.service.store.insertRun(old);
  const directory = join(f.state, "runs", old.run_id),
    candidate = join(directory, "candidate-0");
  mkdirSync(join(candidate, "nested"), { recursive: true });
  writeFileSync(
    join(candidate, "nested", "result.txt"),
    "immutable staged output",
  );
  await makeReadonly(candidate);
  const artifact = f.service.store.artifact(
    old.run_id,
    "text/plain",
    "immutable staged output",
    1000,
  );
  await f.service.retention();
  assert.equal(existsSync(directory), false);
  assert.equal(f.service.store.getRun(old.run_id).expired, true);
  assert.throws(
    () => f.service.store.readArtifact(old.run_id, artifact, 0, 100),
    { code: "ACCESS_DENIED" },
  );
  const replay = await f.service.action(f.actor, old.request);
  assert.equal(replay.error.code, "RUN_EXPIRED");
  assert.equal(
    f.service.store.allRuns().length,
    1,
    "expired IDs cannot start another paid run",
  );
});

test("unconfirmed cleanup prevents retention from destroying its candidate and evidence", async (t) => {
  const f = await configuredService(t);
  const old = f.runRecord("source", {
    state: "failed",
    phase: null,
    finished_at: "2020-01-01T00:00:00Z",
  });
  f.service.store.insertRun(old);
  const directory = join(f.state, "runs", old.run_id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "receipt.txt"), "operator recovery evidence");
  const artifact = f.service.store.artifact(
    old.run_id,
    "text/plain",
    "evidence",
    100,
  );
  f.service.controller.cleanupError = {
    code: "CLEANUP_UNCONFIRMED",
    message: "fixture",
    retryable: false,
  };
  await f.service.retention();
  assert.equal(existsSync(directory), true);
  assert.notEqual(f.service.store.getRun(old.run_id).expired, true);
  assert.equal(
    f.service.store.readArtifact(old.run_id, artifact, 0, 100).truncated,
    false,
  );
});

function socketListening(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(true));
  });
}
test(
  "failed initial retention leaves neither a live listener nor a held state lock",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    const program = `
    import { RuntimeService } from ${JSON.stringify(SERVICE_MODULE)};
    import { serve } from ${JSON.stringify(IPC_MODULE)};
    import { RuntimeError } from ${JSON.stringify(ERROR_MODULE)};
    RuntimeService.prototype.retention = async function () {
      throw new RuntimeError('CLEANUP_FAILED', 'injected filesystem cleanup failure');
    };
    try { await serve(process.argv[1]); process.send({unexpectedSuccess:true}); }
    catch (error) { process.send({code:error.code}); }
    process.once('message', () => process.disconnect());
  `;
    const failed = processRun(f, [
      "--input-type=module",
      "-e",
      program,
      f.config_file,
    ]);
    assert.deepEqual(await failed.message(), { code: "CLEANUP_FAILED" });
    const live = await socketListening(join(f.state, "runtime.sock"));
    const release = acquireStateLock(f.state);
    release();
    assert.equal(
      live,
      false,
      "startup cleanup must close any listener before releasing the ownership lock",
    );
    failed.child.send("exit");
    await bounded(
      failed.completion,
      "failed server exit without leaked listener",
    );
  },
);

for (const operation of ["stop", "close"]) {
  test(
    `service ${operation} cancels and awaits an active operator probe HTTP request`,
    { timeout: 8000 },
    async (t) => {
      const received = deferred(),
        disconnected = deferred();
      let requests = 0;
      const provider = createServer((request, response) => {
        requests++;
        request.resume();
        request.once("end", received.resolve);
        response.once("close", disconnected.resolve);
      });
      await new Promise((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
      });
      const f = await configuredService(
        t,
        `http://127.0.0.1:${provider.address().port}/v1`,
      );
      const pending = f.service.control({
        action: "probe_model_profile",
        id: "coding",
      });
      try {
        await bounded(received.promise, "provider received operator probe");
        if (operation === "stop") {
          const stopped = await bounded(
            f.service.control({ action: "stop" }),
            "operator stop",
          );
          assert.equal(stopped.ok, true);
        } else await bounded(f.closeService(), "service close");
        const probe = await bounded(
          pending,
          "probe cancellation acknowledgement",
          1000,
        );
        assert.equal(probe.ok, false);
        assert.equal(probe.error.code, "CANCELLED");
        await bounded(
          disconnected.promise,
          "provider transport disconnect",
          1000,
        );
        assert.equal(
          requests,
          1,
          "cancelled operator probes cannot retry or begin later role probes",
        );
      } finally {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
        await bounded(pending, "failed probe cleanup");
      }
    },
  );
}

async function failDirectoryFsync(fn) {
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory())
      throw Object.assign(new Error("injected directory fsync failure"), {
        code: "EIO",
      });
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
}
test(
  "post-rename durability failure preserves committed configuration and drains admission",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await configuredService(t);
    const before = f.config.current.revision;
    const response = await failDirectoryFsync(() =>
      f.service.control({
        action: "upsert_endpoint",
        id: "new-route",
        expected_revision: null,
        value: {
          protocol: "openai-chat-completions",
          base_url: "https://provider.invalid/v1",
        },
      }),
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "CONFIG_DURABILITY_UNCONFIRMED");
    assert.notEqual(f.config.current.revision, before);
    assert.deepEqual(
      f.config.current,
      new Configuration(f.config_file).current,
    );
    assert.equal(f.service.controller.draining, true);
    const inspection = await f.service.control({ action: "inspect" });
    assert.equal(
      inspection.status.maintenance_error.code,
      "CONFIG_DURABILITY_UNCONFIRMED",
    );
    assert.equal(
      readdirSync(f.state).some((name) => name.endsWith(".tmp")),
      false,
    );
    const start = await f.service.action(f.actor, {
      action: "start",
      client_request_id: "after-uncertain-durability",
      workspace_id: "source",
      task: "must not start",
    });
    assert.equal(start.error.code, "SERVICE_DRAINING");
  },
);

test(
  "post-rename provision and revoke failures retain the same credential authority in memory and on disk",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t),
      config = new Configuration(f.config_file);
    const credentialPath = join(f.directory, "client.json");
    const value = {
      principal: "alice",
      tool_binding: "main",
      workspace_ids: [],
      model_profile_ids: [],
      validation_profile_ids: [],
      actions: ["capabilities"],
    };
    await failDirectoryFsync(async () => {
      assert.throws(() => config.provision("client", value, credentialPath), {
        code: "CONFIG_DURABILITY_UNCONFIRMED",
      });
    });
    assert.equal(
      existsSync(credentialPath),
      true,
      "the committed credential must remain reviewable after uncertain fsync",
    );
    const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
    assert.equal(config.authenticate(credential.token).principal, "alice");
    assert.equal(
      new Configuration(f.config_file).authenticate(credential.token).principal,
      "alice",
    );
    await failDirectoryFsync(async () => {
      assert.throws(
        () => config.revoke("client", config.current.clients.client.revision),
        { code: "CONFIG_DURABILITY_UNCONFIRMED" },
      );
    });
    assert.throws(() => config.authenticate(credential.token), {
      code: "ACCESS_DENIED",
    });
    assert.throws(
      () => new Configuration(f.config_file).authenticate(credential.token),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(config.current, new Configuration(f.config_file).current);
  },
);
