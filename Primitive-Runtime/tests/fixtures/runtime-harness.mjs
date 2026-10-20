import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requestLocal } from "../../dist/runtime/src/control/ipc.js";
import { DEFAULT_LIMITS, ACTIONS } from "../../dist/runtime/src/types.js";
import { removeTree } from "../../dist/runtime/src/workspace/manifest.js";
import { ScriptedProvider } from "./scripted-provider.mjs";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = path.join(ROOT, "dist/runtime/src/cli.js");
export const ENGINE = path.join(
  ROOT,
  "engine/jcode/modified/primitive/target/release/jcode-primitive",
);
const run = promisify(execFile);
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function git(root, args) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
export async function until(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await pause(20);
  }
  throw new Error("Timed out: " + description);
}

export const FIXTURE_FILES = {
  "a-consumer.cjs":
    "const {value}=require('./z-producer.cjs');\nexports.result=()=>value();\n",
  "z-producer.cjs": "exports.value=()=>1;\n",
  "check.cjs":
    "const assert=require('node:assert/strict');\nassert.equal(require('./a-consumer.cjs').result(),42);\nassert.equal(process.env.PRIMITIVE_TEST_SECRET,undefined);\nconsole.log('VERIFIED_BEHAVIOR_42');\n",
};

/** A real subprocess service and real MCP adapter; only the paid model endpoint
 * is replaced by an explicit scripted local HTTP provider. */
export async function harness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pr-accept-"));
  const source = path.join(directory, "source");
  const state = path.join(directory, "state");
  const clients = [];
  const provider = new ScriptedProvider();
  let service;
  let stderr = "";
  let closed = false;
  const env = {
    ...process.env,
    PRIMITIVE_TEST_SECRET: "ambient-secret-must-not-enter-validation",
    ...options.serviceEnv,
  };
  async function stopService(signal = "SIGTERM") {
    if (!service || service.exitCode !== null || service.signalCode !== null)
      return;
    service.kill(signal);
    let timer;
    try {
      await Promise.race([
        once(service, "exit"),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            if (service.exitCode === null && service.signalCode === null)
              service.kill("SIGKILL");
            resolve();
          }, 12000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function cleanup() {
    if (closed) return;
    closed = true;
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopService();
    await provider.close();
    await removeTree(directory);
  }
  t.after(cleanup);
  await fs.mkdir(source);
  for (const [name, content] of Object.entries({
    ...FIXTURE_FILES,
    ...options.files,
  }))
    await fs.writeFile(path.join(source, name), content);
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "fixture baseline"]);
  const baseline = git(source, ["rev-parse", "HEAD"]).trim();
  await provider.start();
  const initialized = await run(
    process.execPath,
    [CLI, "init", "--state-dir", state, "--engine", ENGINE],
    { cwd: ROOT, timeout: 10000 },
  );
  const locations = JSON.parse(initialized.stdout);
  const operator = JSON.parse(
    await fs.readFile(locations.operator_client_file, "utf8"),
  );
  const config = JSON.parse(await fs.readFile(locations.config_file, "utf8"));
  config.limits = {
    ...DEFAULT_LIMITS,
    max_parallel: 1,
    max_input_tokens: 3000000,
    max_output_tokens: 200000,
    max_wall_time_seconds: 90,
    max_provider_retries: 0,
    ...options.limits,
  };
  config.endpoints = {
    fixture: {
      revision: "endpoint-1",
      protocol: "openai-chat-completions",
      base_url: provider.url,
    },
  };
  config.model_profiles = {
    coding: {
      revision: "model-1",
      activator: { endpoint_id: "fixture", model: "activator" },
      primitive: { endpoint_id: "fixture", model: "primitive" },
      diagnosis: { endpoint_id: "fixture", model: "diagnosis" },
    },
  };
  config.validation_profiles = {
    checks: {
      revision: "checks-1",
      backend: "bwrap",
      network: "none",
      tools: [path.dirname(path.dirname(process.execPath))],
      checks: [
        {
          id: "behavior",
          command: process.execPath,
          args: ["--jitless", "--max-old-space-size=64", "check.cjs"],
          required: true,
          timeout_seconds: 15,
        },
      ],
      limits: {
        memory_mb: 16384,
        cpu_seconds: 10,
        pids: 64,
        max_output_bytes: 32768,
        max_disk_mb: 32,
      },
    },
  };
  config.workspaces = {
    fixture: {
      revision: "workspace-1",
      path: source,
      default_model_profile_id: "coding",
      default_validation_profile_id: "checks",
    },
  };
  if (options.configure) options.configure(config);
  await fs.writeFile(locations.config_file, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  async function startService(extraEnv = {}) {
    stderr = "";
    service = spawn(
      process.execPath,
      [CLI, "serve", "--config", locations.config_file],
      {
        cwd: ROOT,
        env: { ...env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    service.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    service.stdout.resume();
    await until(() => {
      if (service.exitCode !== null || service.signalCode !== null)
        throw new Error("Service exited: " + stderr);
      return stderr.includes("service ready");
    }, "service readiness");
  }
  await startService();
  const control = (body) => requestLocal(operator, "/control", body, 20000);
  const clientFile = path.join(directory, "client.json");
  const provision = await control({
    action: "provision_client",
    id: "caller",
    value: {
      principal: "alice",
      tool_binding: "main",
      workspace_ids: ["fixture"],
      model_profile_ids: Object.keys(config.model_profiles),
      validation_profile_ids: Object.keys(config.validation_profiles),
      actions: [...ACTIONS],
    },
    output_file: clientFile,
  });
  assert.equal(provision.ok, true, JSON.stringify(provision));
  const credential = JSON.parse(await fs.readFile(clientFile, "utf8"));
  async function connect(file = clientFile) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--transport", "stdio", "--config", file],
      cwd: ROOT,
      stderr: "pipe",
    });
    transport.stderr?.resume();
    const client = new Client(
      { name: "primitive-acceptance", version: "1.0.0" },
      { capabilities: {} },
    );
    client.onerror = () => {};
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const client = await connect();
  const h = {
    directory,
    source,
    state,
    baseline,
    provider,
    config,
    configFile: locations.config_file,
    operator,
    clientFile,
    credential,
    client,
    connect,
    control,
    stopService,
    startService,
    cleanup,
    get service() {
      return service;
    },
    get stderr() {
      return stderr;
    },
  };
  provider.onSnapshot = () => h;
  return h;
}

export async function tool(client, args) {
  const response = await client.callTool({
    name: "primitive_runtime",
    arguments: args,
  });
  const business = response.structuredContent;
  assert.ok(
    business && typeof business === "object",
    "MCP response must have structuredContent",
  );
  const texts = response.content.filter((item) => item.type === "text");
  assert.equal(texts.length, 1);
  assert.deepEqual(
    JSON.parse(texts[0].text),
    business,
    "MCP structuredContent and text JSON must agree",
  );
  assert.equal(
    response.isError,
    business.ok !== true,
    "Only failed tool lookups set isError",
  );
  return business;
}

export async function start(h, task, extra = {}) {
  const response = await tool(h.client, {
    action: "start",
    client_request_id: task,
    workspace_id: "fixture",
    task,
    ...extra,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.run.run_id;
}

export async function terminal(h, id, client = h.client) {
  const events = [];
  let after = "0";
  const end = Date.now() + 100000;
  while (Date.now() < end) {
    const status = await tool(client, {
      action: "status",
      run_id: id,
      after_event_id: after,
      wait_ms: 1000,
    });
    assert.equal(status.ok, true, JSON.stringify(status));
    events.push(...status.events);
    after = status.events.at(-1)?.event_id ?? after;
    if (status.run.terminal && !status.next_event_id) {
      const result = await tool(client, { action: "result", run_id: id });
      assert.equal(result.ok, true, JSON.stringify(result));
      return { result, events };
    }
  }
  throw new Error("Run did not terminate: " + id + "\n" + h.stderr);
}

export async function stopped(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export async function children(pid) {
  try {
    return (await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    // Some Linux kernels omit task/<tid>/children. PPid remains available in
    // /proc/<pid>/stat, including processes launched by another Node thread.
    const entries = (await fs.readdir("/proc")).filter((name) =>
      /^[0-9]+$/.test(name),
    );
    const matches = await Promise.all(
      entries.map(async (name) => {
        try {
          const stat = await fs.readFile(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          return Number(fields[1]) === pid ? Number(name) : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return matches.filter((value) => value !== undefined);
  }
}
