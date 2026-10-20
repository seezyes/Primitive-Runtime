#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createOperatorConfig, Configuration } from "./control/config.js";
import { serve, loadClientConfig, requestLocal } from "./control/ipc.js";
import { runMcp } from "./mcp/server.js";
import { versions } from "./service.js";
import { probeSandbox, recoverValidationLeases } from "./validation/index.js";
import { inspectEngine } from "./engine/version.js";
import { acquireStateLock } from "./control/state-lock.js";
import { check, safeError, RuntimeError } from "./errors.js";
const HELP =
  "Primitive Runtime\n\nprimitive-runtime version --json\nprimitive-runtime init --state-dir ABSOLUTE_PATH --engine ABSOLUTE_BINARY\nprimitive-runtime doctor --config OPERATOR_JSON --json\nprimitive-runtime serve --config OPERATOR_JSON\nprimitive-runtime mcp --transport stdio --config CLIENT_JSON\nprimitive-runtime tui --config OPERATOR_CLIENT_JSON\nprimitive-runtime control --config OPERATOR_CLIENT_JSON --request REQUEST_JSON_FILE\n\nThe service is started explicitly. MCP clients never install or start a service.\n";
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv.shift() ?? "help";
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      config: { type: "string" },
      transport: { type: "string" },
      "state-dir": { type: "string" },
      engine: { type: "string" },
      request: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (command === "help" || values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "version") {
    process.stdout.write(JSON.stringify(versions(), null, 2) + "\n");
    return;
  }
  if (command === "init") {
    check(
      values["state-dir"] && values.engine,
      "INVALID_ARGUMENT",
      "init requires --state-dir and --engine.",
    );
    const result = createOperatorConfig(
      resolve(values["state-dir"]),
      resolve(values.engine),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  check(
    values.config,
    "CONFIG_REQUIRED",
    "Specify --config with the appropriate operator or client configuration.",
  );
  const file = resolve(values.config);
  if (command === "serve") {
    const running = await serve(file);
    const stop = () => void running.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stderr.write("Primitive Runtime service ready.\n");
    await running.closed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    return;
  }
  if (command === "mcp") {
    check(
      !values.transport || values.transport === "stdio",
      "INVALID_ARGUMENT",
      "Only stdio MCP transport is supported.",
    );
    await runMcp(file);
    return;
  }
  if (command === "control") {
    check(
      values.request,
      "INVALID_ARGUMENT",
      "control requires --request JSON_FILE.",
    );
    const result = await requestLocal(
      loadClientConfig(file),
      "/control",
      JSON.parse(readFileSync(resolve(values.request), "utf8")),
      100000,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "tui") {
    const config = loadClientConfig(file);
    const moduleUrl = new URL(
      "../../../packages/operator-tui/src/index.mjs",
      import.meta.url,
    ).href;
    const panel = await import(moduleUrl);
    await panel.runTui({
      call: (value: unknown) => requestLocal(config, "/control", value, 100000),
    });
    return;
  }
  if (command === "doctor") {
    const config = new Configuration(file).current;
    const releaseLock = acquireStateLock(config.state_dir);
    try {
      const engine = await inspectEngine(config.engine);
      await recoverValidationLeases(join(config.state_dir, "doctor-leases"));
      const sandboxes = await Promise.all(
        Object.entries(config.validation_profiles).map(async ([id, p]) => ({
          id,
          ...(await probeSandbox(p, undefined, {
            lease_dir: join(config.state_dir, "doctor-leases"),
          })),
        })),
      );
      const result = {
        ...versions(),
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        engine,
        sandboxes,
        configured_workspaces: Object.keys(config.workspaces),
        configured_model_profiles: Object.keys(config.model_profiles),
        ready:
          engine.available &&
          sandboxes.some((s) => s.available) &&
          Object.keys(config.workspaces).length > 0 &&
          Object.keys(config.model_profiles).length > 0,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (!result.ready) process.exitCode = 1;
      return;
    } finally {
      releaseLock();
    }
  }
  throw new RuntimeError(
    "INVALID_ARGUMENT",
    "Unknown command. Run primitive-runtime help.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: safeError(error) }) + "\n",
    );
    process.exitCode = 1;
  });
