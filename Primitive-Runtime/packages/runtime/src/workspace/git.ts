import { spawn } from "node:child_process";
import { RuntimeError } from "../errors.js";
import { artifactPath } from "./paths.js";

export async function git(
  root: string,
  args: readonly string[],
  accepted = [0],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.ignoreStat=false",
        "-c",
        "core.trustctime=true",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.external=",
        ...args,
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          LANG: "C.UTF-8",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    let output = Buffer.alloc(0);
    let errors = Buffer.alloc(0);
    let overflow = false;
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 32 * 1024 * 1024) {
        overflow = true;
        abort();
      } else output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 8192)
        errors = Buffer.concat([
          errors,
          chunk.subarray(0, 8192 - errors.length),
        ]);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        new RuntimeError(
          "WORKSPACE_UNAVAILABLE",
          `Git could not start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted)
        return reject(
          new RuntimeError("CANCELLED", "Workspace operation was cancelled."),
        );
      if (overflow)
        return reject(
          new RuntimeError(
            "BUDGET_EXCEEDED",
            "Git output exceeded the bounded workspace limit.",
          ),
        );
      if (code === null || !accepted.includes(code))
        return reject(
          new RuntimeError(
            "WORKSPACE_UNAVAILABLE",
            `Git operation failed: ${errors.toString("utf8").trim().slice(0, 1024) || "command did not complete"}`,
          ),
        );
      resolve(output.toString("utf8"));
    });
    if (signal?.aborted) abort();
  });
}

export async function cleanGitState(
  root: string,
  signal?: AbortSignal,
): Promise<{ head: string; paths: string[] }> {
  const status = await git(
    root,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    [0],
    signal,
  );
  if (status.length)
    throw new RuntimeError(
      "WORKSPACE_DIRTY",
      "The workspace has staged, modified, or untracked files. Commit or remove those changes first.",
    );
  const head = (
    await git(root, ["rev-parse", "--verify", "HEAD"], [0], signal)
  ).trim();
  const stages = await git(root, ["ls-files", "--stage", "-z"], [0], signal);
  const entries = stages.split("\0").filter(Boolean);
  const paths = entries.map((entry) => {
    const match = /^(\d+) [0-9a-f]+ (\d)\t([\s\S]+)$/u.exec(entry);
    if (
      !match ||
      match[2] !== "0" ||
      !["100644", "100755"].includes(match[1]!)
    ) {
      throw new RuntimeError(
        "UNSUPPORTED_ARTIFACT",
        "Unmerged entries, symlinks, and submodules are unsupported.",
      );
    }
    return artifactPath(match[3]!);
  });
  const flags = (await git(root, ["ls-files", "-v", "-z"], [0], signal))
    .split("\0")
    .filter(Boolean);
  if (flags.some((item) => !item.startsWith("H "))) {
    throw new RuntimeError(
      "WORKSPACE_DIRTY",
      "Sparse, skip-worktree, and assume-unchanged index entries cannot be snapshotted safely.",
    );
  }
  return { head, paths };
}
