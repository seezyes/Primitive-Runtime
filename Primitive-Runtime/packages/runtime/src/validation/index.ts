import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { RuntimeError } from "../errors.js";
import { hashManifest, scanManifest } from "../workspace/manifest.js";
import {
  CANDIDATE_SCAN_LIMITS,
  runIsolated,
  validateProfile,
} from "./sandbox.js";
import type {
  CheckResult,
  SandboxProbe,
  ValidationOptions,
  ValidationProfile,
  ValidationReport,
} from "./types.js";

export type {
  CheckResult,
  SandboxProbe,
  ValidationCheck,
  ValidationOptions,
  ValidationProfile,
  ValidationReport,
} from "./types.js";
export { recoverValidationLeases } from "./leases.js";

export async function probeSandbox(
  profile: ValidationProfile,
  signal?: AbortSignal,
  options?: ValidationOptions,
): Promise<SandboxProbe> {
  let directory: string | undefined;
  try {
    validateProfile(profile);
    directory = await fs.mkdtemp(path.join(tmpdir(), "primitive-probe-"));
    const result = await runIsolated(
      directory,
      {
        id: "sandbox-probe",
        command: "/bin/true",
        args: [],
        required: true,
        timeout_seconds: 10,
      },
      {
        ...profile,
        limits: { ...profile.limits, max_output_bytes: 8192 },
      },
      signal,
      options,
    );
    return {
      available:
        result.started === true &&
        result.code === 0 &&
        !result.overflow &&
        !result.timedOut &&
        !result.spawnError,
      backend: profile.backend,
      proc: profile.backend === "docker",
      ...(result.code !== 0 || result.spawnError || !result.started
        ? {
            reason:
              result.spawnError ??
              (result.output.trim().slice(0, 2048) || "Sandbox probe failed."),
          }
        : {}),
    };
  } catch (error) {
    return {
      available: false,
      backend: profile?.backend ?? "unknown",
      reason: (error as Error).message,
    };
  } finally {
    if (directory) await fs.rmdir(directory);
  }
}

function unavailable(
  profile: ValidationProfile,
  hash: string,
  error: { code: string; message: string },
  checks: CheckResult[] = [],
): ValidationReport {
  const existing = new Set(checks.map((check) => check.check_id));
  return {
    checks: [
      ...checks,
      ...profile.checks
        .filter((check) => !existing.has(check.id))
        .map((check) => ({
          check_id: check.id,
          status: "unavailable" as const,
          required: check.required,
          exit_code: null,
          output: "",
          timed_out: false,
          candidate_hash: hash,
        })),
    ],
    verification: "unverified",
    infrastructure_error: error,
  };
}

export async function validateCandidate(
  candidateRoot: string,
  candidateHash: string,
  profile: ValidationProfile,
  signal?: AbortSignal,
  options?: ValidationOptions,
): Promise<ValidationReport> {
  validateProfile(profile);
  if (!profile.checks.some((check) => check.required)) {
    return unavailable(profile, candidateHash, {
      code: "VALIDATION_UNAVAILABLE",
      message: "At least one mandatory check is required for verified success.",
    });
  }
  // Copy the trusted profile before awaiting; mutations in another control request
  // cannot alter an in-flight validation plan or its mandatory flags.
  const pinned = structuredClone(profile);
  const checks: CheckResult[] = [];
  const unchanged = async () => {
    const manifest = await scanManifest(
      candidateRoot,
      CANDIDATE_SCAN_LIMITS,
      signal,
    );
    if (hashManifest(manifest) !== candidateHash)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Candidate identity does not match the frozen validation revision.",
      );
  };
  try {
    await unchanged();
    const probe = await probeSandbox(pinned, signal, options);
    signal?.throwIfAborted();
    if (!probe.available)
      return unavailable(pinned, candidateHash, {
        code: "UNSUPPORTED_SANDBOX",
        message: probe.reason ?? "Configured sandbox is unavailable.",
      });
    for (const check of pinned.checks) {
      signal?.throwIfAborted();
      await unchanged();
      const result = await runIsolated(
        candidateRoot,
        check,
        pinned,
        signal,
        options,
      );
      await unchanged();
      if (
        !result.started ||
        result.spawnError ||
        [125, 126, 127].includes(result.code ?? -1)
      ) {
        return unavailable(
          pinned,
          candidateHash,
          {
            code: "VALIDATION_UNAVAILABLE",
            message: result.spawnError ?? "Container setup failed.",
          },
          checks,
        );
      }
      checks.push({
        check_id: check.id,
        status:
          result.code === 0 && !result.timedOut && !result.overflow
            ? "passed"
            : "failed",
        required: check.required,
        exit_code: result.code,
        output: result.output,
        timed_out: result.timedOut,
        candidate_hash: candidateHash,
        ...(result.overflow ? { output_truncated: true } : {}),
      });
    }
    return {
      checks,
      verification: checks.some(
        (check) => check.required && check.status !== "passed",
      )
        ? "failed"
        : "passed",
      sandbox: {
        backend: pinned.backend,
        proc: pinned.backend === "docker",
        network: "none",
        memory_limit_scope:
          pinned.backend === "docker" ? "container" : "process-address-space",
        cpu_limit_scope:
          pinned.backend === "docker" ? "container-wall-cap" : "process",
      },
    };
  } catch (error) {
    if (
      signal?.aborted ||
      (error as { code?: string }).code === "CANCELLED" ||
      (error as { code?: string }).code === "CLEANUP_FAILED"
    )
      throw error;
    return unavailable(
      pinned,
      candidateHash,
      {
        code: (error as { code?: string }).code ?? "VALIDATION_UNAVAILABLE",
        message: (error as Error).message,
      },
      checks,
    );
  }
}
