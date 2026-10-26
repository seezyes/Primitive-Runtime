import { spawn, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RuntimeError } from "../errors.js";

export interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  overflow: boolean;
  started?: boolean;
  spawnError?: string;
}

export function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    LANG: "C.UTF-8",
  };
}

export async function commandPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(
    path.delimiter,
  )) {
    if (!directory) continue;
    const file = path.join(directory, name);
    try {
      await fs.access(file, fs.constants.X_OK);
      return file;
    } catch {
      /* next PATH component */
    }
  }
  throw new RuntimeError(
    "UNSUPPORTED_SANDBOX",
    `Required sandbox executable ${name} is unavailable.`,
  );
}

/** Process-group cancellation; sandbox init/daemon cleanup handles escaped groups. */
export async function runBounded(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    fd?: number;
    onStop?: () => Promise<void>;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    throw new RuntimeError("CANCELLED", "Validation was cancelled.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:
        options.fd === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", options.fd],
      env: options.env ?? cleanEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let total = 0;
    const chunks: Buffer[] = [];
    let timedOut = false;
    let overflow = false;
    let spawnError: string | undefined;
    let cleanup: Promise<void> = Promise.resolve();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      // Windows does not implement negative-PID process groups. taskkill /T
      // traverses the descendant tree; the acknowledged result is part of the
      // cleanup fence. This is a best-effort fallback, NOT a Job Object and
      // does not cover a parent crash or escaped descendants.
      if (process.platform === "win32" && child.pid) {
        const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        cleanup = new Promise<void>((resolveCleanup, rejectCleanup) => {
          if (!root) {
            reject(new RuntimeError("CLEANUP_FAILED", "Windows SystemRoot is unavailable."));
            return;
          }
          execFile(path.join(root, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 12000 },
            (error) => {
              if (error && child.exitCode === null && child.signalCode === null)
                rejectCleanup(new RuntimeError("CLEANUP_FAILED",
                  "Windows process-tree termination was not acknowledged."));
              else resolveCleanup();
            });
        });
        if (options.onStop) cleanup = Promise.all([cleanup, options.onStop()]).then(() => {});
      } else {
        if (options.onStop) cleanup = options.onStop();
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            spawnError = "Could not terminate the validation process group.";
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    const append = (chunk: Buffer) => {
      const room = options.maxBytes - total;
      if (room > 0) {
        const kept = chunk.subarray(0, room);
        chunks.push(kept);
        total += kept.length;
      }
      if (chunk.length > room) {
        overflow = true;
        stop();
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        await cleanup;
      } catch {
        return reject(
          new RuntimeError(
            "CLEANUP_FAILED",
            "The validation backend did not acknowledge process-tree cleanup.",
          ),
        );
      }
      if (options.signal?.aborted)
        return reject(
          new RuntimeError(
            "CANCELLED",
            "Validation was cancelled after sandbox cleanup.",
          ),
        );
      resolve({
        code,
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
        overflow,
        ...(spawnError ? { spawnError } : {}),
      });
    });
    if (options.signal?.aborted) abort();
  });
}
