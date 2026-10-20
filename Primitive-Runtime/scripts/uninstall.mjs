#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { uninstallRuntime } from "./lib/state.mjs";
import { requireValue } from "./lib/release.mjs";

export { uninstallRuntime } from "./lib/state.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [directory, confirmation, ...extra] = process.argv.slice(2);
    requireValue(
      directory &&
        confirmation === "--delete-runtime-state" &&
        extra.length === 0,
      "Usage: node scripts/uninstall.mjs ABSOLUTE_STATE_DIRECTORY --delete-runtime-state",
    );
    console.log(JSON.stringify(await uninstallRuntime(directory)));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
