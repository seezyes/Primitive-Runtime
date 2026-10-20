import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { RuntimeError } from "../errors.js";
import {
  copyManifest,
  makeReadonly,
  removeTree,
  scanManifest,
} from "../workspace/manifest.js";
import { seccompFilter } from "./seccomp.js";
import { cleanEnvironment, commandPath, runBounded } from "./process.js";
import {
  cleanupDockerLease,
  createDockerLease,
  dockerLeaseLabel,
  markDockerCreated,
} from "./leases.js";
import type { ProcessResult } from "./process.js";
import type {
  ValidationCheck,
  ValidationOptions,
  ValidationProfile,
} from "./types.js";

const READY = "__PRIMITIVE_VALIDATION_READY_v1__\n";
const COPY_AND_RUN =
  'set -eu; cp -R /candidate/. /workspace/; chmod -R u+w /workspace; if ! command -v "$1" >/dev/null 2>&1; then printf "Configured validation executable is unavailable.\\n" >&2; exit 127; fi; printf "__PRIMITIVE_VALIDATION_READY_v1__\\n" >&2; exec "$@"';
export const CANDIDATE_SCAN_LIMITS = {
  max_file_bytes: 256 * 1024 * 1024,
  max_workspace_bytes: 2 * 1024 * 1024 * 1024,
  max_files: 100_000,
};

export function validateProfile(profile: ValidationProfile): void {
  if (
    !profile ||
    !["bwrap", "docker"].includes(profile.backend) ||
    profile.network !== "none" ||
    typeof profile.revision !== "string" ||
    !profile.revision ||
    !Array.isArray(profile.checks) ||
    profile.checks.length > 64
  ) {
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Validation needs an immutable profile and a supported network-isolated backend.",
    );
  }
  const limitKeys = [
    "memory_mb",
    "cpu_seconds",
    "pids",
    "max_output_bytes",
    "max_disk_mb",
  ] as const;
  for (const key of limitKeys) {
    const value = profile.limits?.[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1)
      throw new RuntimeError(
        "CONFIG_REQUIRED",
        "Validation limits must be bounded positive integers.",
      );
  }
  if (
    profile.limits.pids < 4 ||
    profile.limits.memory_mb < 32 ||
    profile.limits.max_disk_mb < 2
  ) {
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Validation needs at least 4 process slots, 32 MiB memory and 2 MiB scratch disk.",
    );
  }
  const seen = new Set<string>();
  for (const check of profile.checks) {
    if (
      !check ||
      typeof check.id !== "string" ||
      !check.id ||
      seen.has(check.id) ||
      typeof check.command !== "string" ||
      !check.command ||
      check.command.startsWith("-") ||
      check.command.includes("\0") ||
      !Array.isArray(check.args) ||
      check.args.length > 1024 ||
      check.args.some(
        (arg) =>
          typeof arg !== "string" || arg.includes("\0") || arg.length > 65_536,
      ) ||
      typeof check.required !== "boolean" ||
      !Number.isSafeInteger(check.timeout_seconds) ||
      check.timeout_seconds < 1 ||
      check.timeout_seconds > 86_400
    ) {
      throw new RuntimeError(
        "CONFIG_REQUIRED",
        "Validation check configuration is invalid.",
      );
    }
    seen.add(check.id);
  }
  if (
    profile.backend === "docker" &&
    (!profile.image ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:~-]*@sha256:[a-f0-9]{64}$/u.test(
        profile.image,
      ))
  ) {
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Docker validation requires a locally installed Linux image pinned by sha256 digest.",
    );
  }
}

async function readonlyToolBindings(
  profile: ValidationProfile,
): Promise<string[]> {
  const result: string[] = [];
  const forbidden = [
    "/",
    "/home",
    "/root",
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/tmp",
    "/var",
    "/run",
    "/workspace",
    "/candidate",
  ];
  const forbiddenPath = (value: string) =>
    forbidden.some(
      (prefix) =>
        value === prefix || (prefix !== "/" && value.startsWith(`${prefix}/`)),
    );
  for (const location of [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    ...(profile.tools ?? []),
  ]) {
    if (
      !path.isAbsolute(location) ||
      path.normalize(location) !== location ||
      /[\0\r\n]/u.test(location) ||
      forbiddenPath(location)
    ) {
      throw new RuntimeError(
        "CONFIG_REQUIRED",
        "Additional tool paths must be explicit system tool directories.",
      );
    }
    try {
      const stat = await fs.stat(location);
      if (!stat.isDirectory())
        throw new RuntimeError(
          "CONFIG_REQUIRED",
          "Tool bindings must be directories.",
        );
      if (forbiddenPath(await fs.realpath(location)))
        throw new RuntimeError(
          "CONFIG_REQUIRED",
          "Tool bindings cannot expose credential or host-state directories through aliases.",
        );
      result.push("--ro-bind", location, location);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        ["/lib", "/lib64"].includes(location)
      )
        continue;
      throw error;
    }
  }
  return result;
}

async function bubblewrap(
  candidateRoot: string,
  check: ValidationCheck,
  profile: ValidationProfile,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new RuntimeError(
      "UNSUPPORTED_SANDBOX",
      "Bubblewrap validation currently requires Linux x64.",
    );
  const executable = await commandPath("bwrap");
  await commandPath("prlimit");
  const staging = await fs.mkdtemp(
    path.join(tmpdir(), "primitive-validation-"),
  );
  let policy: fs.FileHandle | undefined;
  try {
    const manifest = await scanManifest(
      candidateRoot,
      CANDIDATE_SCAN_LIMITS,
      signal,
    );
    const bytes = Object.values(manifest).reduce(
      (total, item) => total + item.size,
      0,
    );
    const diskBytes = profile.limits.max_disk_mb * 1024 * 1024;
    const workspaceBytes = Math.floor(diskBytes * 0.8);
    if (bytes > workspaceBytes)
      throw new RuntimeError(
        "VALIDATION_UNAVAILABLE",
        "Candidate does not fit within the configured sandbox disk limit.",
      );
    const candidate = path.join(staging, "candidate");
    await fs.mkdir(candidate, { mode: 0o700 });
    await copyManifest(candidateRoot, candidate, manifest, signal);
    await makeReadonly(candidate);
    const policyFile = path.join(staging, "policy.bpf");
    await fs.writeFile(policyFile, seccompFilter(), {
      mode: 0o600,
      flag: "wx",
    });
    policy = await fs.open(policyFile, "r");
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--cap-drop",
      "ALL",
      ...(await readonlyToolBindings(profile)),
      "--dir",
      "/proc",
      "--dev",
      "/dev",
      "--remount-ro",
      "/dev",
      "--perms",
      "1777",
      "--size",
      String(workspaceBytes),
      "--tmpfs",
      "/workspace",
      "--perms",
      "1777",
      "--size",
      String(diskBytes - workspaceBytes),
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      candidate,
      "/candidate",
      "--dir",
      "/home",
      "--dir",
      "/home/primitive",
      "--remount-ro",
      "/",
      "--chdir",
      "/workspace",
      "--setenv",
      "PATH",
      "/usr/local/bin:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/home/primitive",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--seccomp",
      "3",
      "--",
      "/usr/bin/prlimit",
      `--as=${profile.limits.memory_mb * 1024 * 1024}:${profile.limits.memory_mb * 1024 * 1024}`,
      `--cpu=${profile.limits.cpu_seconds}:${profile.limits.cpu_seconds}`,
      `--nproc=${profile.limits.pids}:${profile.limits.pids}`,
      `--fsize=${diskBytes}:${diskBytes}`,
      "--nofile=256:256",
      "--",
      "/bin/sh",
      "-c",
      COPY_AND_RUN,
      "primitive-check",
      check.command,
      ...check.args,
    ];
    let launcher = executable;
    let launcherArgs = args;
    if (process.getuid?.() === 0) {
      // RLIMIT_NPROC is not enforced for global UID 0, even after a namespace UID change.
      // Drop the HOST identity before starting the namespace rather than claiming a false cap.
      launcher = await commandPath("setpriv");
      await fs.chown(staging, 65534, 65534);
      launcherArgs = [
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "--",
        executable,
        ...args,
      ];
    }
    return await runBounded(launcher, launcherArgs, {
      timeoutMs: check.timeout_seconds * 1000,
      maxBytes: profile.limits.max_output_bytes + Buffer.byteLength(READY),
      signal,
      fd: policy.fd,
    });
  } finally {
    await policy?.close();
    await removeTree(staging);
  }
}

async function docker(
  candidateRoot: string,
  check: ValidationCheck,
  profile: ValidationProfile,
  signal?: AbortSignal,
  options?: ValidationOptions,
): Promise<ProcessResult> {
  if (!options?.lease_dir)
    throw new RuntimeError(
      "UNSUPPORTED_SANDBOX",
      "Docker validation requires a durable service-owned lease directory and startup recovery.",
    );
  if (candidateRoot.includes(","))
    throw new RuntimeError(
      "VALIDATION_UNAVAILABLE",
      "The Docker candidate path cannot contain mount-option separators.",
    );
  const executable = await commandPath(
    process.platform === "win32" ? "docker.exe" : "docker",
  );
  const config = await fs.mkdtemp(path.join(tmpdir(), "primitive-docker-"));
  const env = { ...cleanEnvironment(), DOCKER_CONFIG: config };
  const callDocker = (args: string[]) =>
    runBounded(executable, args, { timeoutMs: 15_000, maxBytes: 16_384, env });
  let lease: Awaited<ReturnType<typeof createDockerLease>> | undefined;
  let creationAcknowledged = false;
  try {
    const info = await callDocker(["info", "--format", "{{.OSType}}"]);
    if (info.code !== 0 || info.output.trim() !== "linux")
      throw new RuntimeError(
        "UNSUPPORTED_SANDBOX",
        "A reachable local Docker daemon running Linux containers is required.",
      );
    const image = await callDocker([
      "image",
      "inspect",
      profile.image!,
      "--format",
      "{{.Id}}",
    ]);
    if (image.code !== 0)
      throw new RuntimeError(
        "UNSUPPORTED_SANDBOX",
        "The configured pinned Docker image is not installed; automatic image pulls are disabled.",
      );
    const disk = profile.limits.max_disk_mb * 1024 * 1024;
    const workspaceDisk = Math.floor(disk * 0.8);
    const manifest = await scanManifest(
      candidateRoot,
      CANDIDATE_SCAN_LIMITS,
      signal,
    );
    if (
      Object.values(manifest).reduce((total, item) => total + item.size, 0) >
      workspaceDisk
    )
      throw new RuntimeError(
        "VALIDATION_UNAVAILABLE",
        "Candidate does not fit within the configured sandbox disk limit.",
      );
    signal?.throwIfAborted();
    lease = await createDockerLease(options.lease_dir);
    const args = [
      "create",
      "--pull=never",
      "--name",
      lease.name,
      "--label",
      dockerLeaseLabel(lease),
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${profile.limits.pids}`,
      `--memory=${profile.limits.memory_mb}m`,
      `--memory-swap=${profile.limits.memory_mb}m`,
      "--cpus=1",
      "--ulimit",
      `cpu=${profile.limits.cpu_seconds}:${profile.limits.cpu_seconds}`,
      "--ulimit",
      `fsize=${disk}:${disk}`,
      "--ulimit",
      "nofile=256:256",
      "--user=65534:65534",
      "--workdir=/workspace",
      "--mount",
      `type=bind,src=${path.resolve(candidateRoot)},dst=/candidate,readonly`,
      "--tmpfs",
      `/workspace:rw,nosuid,nodev,size=${workspaceDisk},mode=1777`,
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,size=${disk - workspaceDisk},mode=1777`,
      "--env",
      "HOME=/tmp",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "LANG=C.UTF-8",
      "--entrypoint=/bin/sh",
      profile.image!,
      "-c",
      COPY_AND_RUN,
      "primitive-check",
      check.command,
      ...check.args,
    ];
    // Creation is acknowledged before cancellation can discard the only identity.
    // An unknown creation result retains its receipt and blocks further admission.
    const created = await callDocker(args);
    if (created.timedOut || created.spawnError)
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Docker container creation was not acknowledged; the durable receipt is retained.",
      );
    creationAcknowledged = true;
    if (created.code !== 0) return { ...created, started: false };
    await markDockerCreated(lease, created.output.trim());
    signal?.throwIfAborted();
    const result = await runBounded(
      executable,
      ["start", "--attach", lease.name],
      {
        timeoutMs:
          Math.min(check.timeout_seconds, profile.limits.cpu_seconds) * 1000,
        maxBytes: profile.limits.max_output_bytes + Buffer.byteLength(READY),
        signal,
        env,
      },
    );
    return result;
  } finally {
    try {
      if (lease)
        await cleanupDockerLease(lease, executable, env, creationAcknowledged);
    } finally {
      await removeTree(config);
    }
  }
}

export async function runIsolated(
  candidateRoot: string,
  check: ValidationCheck,
  profile: ValidationProfile,
  signal?: AbortSignal,
  options?: ValidationOptions,
): Promise<ProcessResult> {
  const result = await (profile.backend === "bwrap"
    ? bubblewrap(candidateRoot, check, profile, signal)
    : docker(candidateRoot, check, profile, signal, options));
  const marker = result.output.indexOf(READY);
  return {
    ...result,
    started: marker !== -1,
    output:
      marker === -1
        ? result.output
        : result.output.slice(0, marker) +
          result.output.slice(marker + READY.length),
  };
}
