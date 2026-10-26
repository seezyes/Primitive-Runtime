import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hash } from "../util.js";
import { RuntimeError } from "../errors.js";

export interface EngineInspection {
  available: boolean;
  hash_matches: boolean;
  sha256: string | null;
  version: Record<string, unknown> | null;
  error: string | null;
}

/** Inspect only the operator-pinned executable; never discover a user's daemon. */
export async function inspectEngine(
  engine: { binary: string; sha256: string },
  signal?: AbortSignal,
): Promise<EngineInspection> {
  let digest: string;
  try {
    digest = hash(readFileSync(engine.binary));
  } catch {
    return {
      available: false,
      hash_matches: false,
      sha256: null,
      version: null,
      error: "Pinned engine binary is unavailable.",
    };
  }
  if (digest !== engine.sha256)
    return {
      available: false,
      hash_matches: false,
      sha256: digest,
      version: null,
      error: "Pinned engine hash does not match.",
    };
  try {
    const env: NodeJS.ProcessEnv =
      process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot }
        : {};
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        engine.binary,
        ["version", "--json"],
        {
          encoding: "utf8",
          env,
          timeout: 5000,
          maxBuffer: 65536,
          windowsHide: true,
          signal,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const version = JSON.parse(output);
    const valid =
      version?.name === "jcode-primitive" &&
      version.engine_protocol === "primitive-engine/1" &&
      version.policy_revision === "primitive-policy/1" &&
      version.turn_core_protocol === "jcode-turn/1" &&
      version.shared_ordinary_turn_core === true &&
      version.restricted_mode === true &&
      version.ordinary_tools === false &&
      version.ambient_credentials === false;
    return {
      available: valid,
      hash_matches: true,
      sha256: digest,
      version: valid ? version : null,
      error: valid
        ? null
        : "Engine did not acknowledge the supported restricted version.",
    };
  } catch {
    if (signal?.aborted)
      throw new RuntimeError("CANCELLED", "Engine inspection cancelled.");
    return {
      available: false,
      hash_matches: true,
      sha256: digest,
      version: null,
      error: "Pinned engine version inspection failed.",
    };
  }
}
