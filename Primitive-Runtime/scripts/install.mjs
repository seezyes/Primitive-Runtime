#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOperatorConfig } from "../dist/runtime/src/control/config.js";
import { dedicatedStatePath } from "./lib/state.mjs";
import { inspectNative, readJSON, requireValue } from "./lib/release.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function installRuntime(directory, allowUnsignedDevelopment = false) {
  const state = dedicatedStatePath(directory);
  requireValue(
    Number(process.versions.node.split(".")[0]) === 24,
    "This package requires Node.js 24.",
  );
  const platform = process.platform + "-" + process.arch;
  const build = readJSON(join(root, "build-info.json"));
  requireValue(
    build.build_info_version === 1 && build.platform === platform,
    "This package was not built for the current platform.",
  );
  requireValue(
    (build.trust?.kind === "ed25519" &&
      build.trust.release_eligible === true) ||
      (allowUnsignedDevelopment &&
        build.trust?.kind === "unsigned-development" &&
        build.trust.release_eligible === false),
    "This is an unsigned development package. To inspect it locally, pass --allow-unsigned-development explicitly. Verify publisher-signed releases before installation.",
  );
  const binary = join(
    root,
    "bin",
    platform,
    process.platform === "win32" ? "jcode-primitive.exe" : "jcode-primitive",
  );
  const native = inspectNative(binary);
  requireValue(
    native.sha256 === build.engine?.sha256 &&
      native.source_revision === build.engine?.source_revision,
    "Packaged engine does not match the recorded build provenance.",
  );
  const installed = createOperatorConfig(state, binary);
  return {
    ...installed,
    platform,
    release_eligible: build.trust.release_eligible,
    source_revision: build.source_revision,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [directory, option, ...extra] = process.argv.slice(2);
    requireValue(
      directory &&
        extra.length === 0 &&
        (!option || option === "--allow-unsigned-development"),
      "Usage: node scripts/install.mjs ABSOLUTE_PRIVATE_STATE_DIRECTORY [--allow-unsigned-development]",
    );
    console.log(
      JSON.stringify(
        installRuntime(directory, option === "--allow-unsigned-development"),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
