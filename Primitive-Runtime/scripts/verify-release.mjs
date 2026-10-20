#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireValue, verifyRelease } from "./lib/release.mjs";

export { verifyRelease } from "./lib/release.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [directory, keyFile, expectedKeyId, platform, ...extra] =
      process.argv.slice(2);
    requireValue(
      directory && keyFile && expectedKeyId && extra.length === 0,
      "Usage: node verify-release.mjs DIRECTORY TRUSTED_PUBLISHER_PUBLIC_KEY EXPECTED_KEY_ID [EXPECTED_PLATFORM]",
    );
    console.log(
      JSON.stringify(
        verifyRelease(directory, keyFile, expectedKeyId, platform),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
