#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../tests/", import.meta.url)))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
let failed = 0;
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["tests/" + file], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  if (code !== 0) failed++;
}
process.stdout.write(
  `\nTest files: ${files.length - failed} passed, ${failed} failed. Individual case counts are reported above.\n`,
);
process.exitCode = failed ? 1 : 0;
