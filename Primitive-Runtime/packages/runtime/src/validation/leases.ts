import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { RuntimeError } from "../errors.js";
import { cleanEnvironment, commandPath, runBounded } from "./process.js";
import { removeTree } from "../workspace/manifest.js";

const LABEL = "org.primitive-runtime.validation-lease";
export interface DockerLease {
  version: 1;
  backend: "docker";
  label: string;
  name: string;
  phase: "creating" | "created";
  container_id?: string;
  created_at: string;
  worker_pid: number;
  file: string;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createDockerLease(
  directory: string,
): Promise<DockerLease> {
  const absolute = path.resolve(directory);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Validation leases need a real service-owned directory.",
    );
  const label = randomUUID();
  const lease: DockerLease = {
    version: 1,
    backend: "docker",
    label,
    name: `primitive-validation-${label}`,
    phase: "creating",
    created_at: new Date().toISOString(),
    worker_pid: process.pid,
    file: path.join(absolute, `${label}.json`),
  };
  const handle = await fs.open(lease.file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(lease));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(absolute);
  return lease;
}

export async function markDockerCreated(
  lease: DockerLease,
  id: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw new RuntimeError(
      "CLEANUP_FAILED",
      "Docker returned an invalid container identity.",
    );
  const next: DockerLease = { ...lease, phase: "created", container_id: id };
  const temporary = `${lease.file}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(next));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, lease.file);
  await syncDirectory(path.dirname(lease.file));
  Object.assign(lease, next);
}

export function dockerLeaseLabel(lease: DockerLease): string {
  return `${LABEL}=${lease.label}`;
}

/** Never remove an unrelated name or lose a receipt while creation is indeterminate. */
export async function cleanupDockerLease(
  lease: DockerLease,
  executable: string,
  env: NodeJS.ProcessEnv,
  creationAcknowledged = false,
): Promise<void> {
  const call = (args: string[]) =>
    runBounded(executable, args, { timeoutMs: 15_000, maxBytes: 16_384, env });
  const inspect = await call([
    "inspect",
    "--type=container",
    lease.name,
    "--format",
    "{{json .}}",
  ]);
  if (inspect.code !== 0) {
    if (
      !inspect.output.includes("No such") ||
      inspect.timedOut ||
      inspect.spawnError
    )
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Docker container cleanup could not inspect its recorded lease.",
      );
    if (lease.phase === "creating" && !creationAcknowledged) {
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Docker creation was interrupted before acknowledgement. The durable receipt is retained for operator recovery.",
      );
    }
  } else {
    let container: {
      Id?: string;
      Config?: { Labels?: Record<string, string> };
    };
    try {
      container = JSON.parse(inspect.output);
    } catch {
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Docker returned an invalid container inspection response.",
      );
    }
    if (
      container.Config?.Labels?.[LABEL] !== lease.label ||
      (lease.container_id && container.Id !== lease.container_id)
    ) {
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Container identity does not match the durable validation lease.",
      );
    }
    const removed = await call(["rm", "--force", lease.name]);
    if (removed.code !== 0 || removed.timedOut || removed.spawnError)
      throw new RuntimeError(
        "CLEANUP_FAILED",
        "Docker did not acknowledge removal of the recorded validation container.",
      );
  }
  await fs.unlink(lease.file);
  await syncDirectory(path.dirname(lease.file));
}

/** Call before admitting new work after a service restart. Unknown create outcomes fail closed. */
export async function recoverValidationLeases(
  directory: string,
): Promise<{ recovered: string[] }> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { recovered: [] };
    throw error;
  }
  const files = entries.filter((name) => name.endsWith(".json"));
  if (!files.length) return { recovered: [] };
  const executable = await commandPath(
    process.platform === "win32" ? "docker.exe" : "docker",
  );
  const config = await fs.mkdtemp(
    path.join(tmpdir(), "primitive-docker-recovery-"),
  );
  const env = { ...cleanEnvironment(), DOCKER_CONFIG: config };
  const recovered: string[] = [];
  try {
    for (const file of files.sort()) {
      const absolute = path.resolve(directory, file);
      const stat = await fs.lstat(absolute);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 16_384
      )
        throw new RuntimeError(
          "CLEANUP_FAILED",
          "Invalid validation lease file.",
        );
      let lease: DockerLease;
      try {
        lease = JSON.parse(await fs.readFile(absolute, "utf8")) as DockerLease;
      } catch {
        throw new RuntimeError(
          "CLEANUP_FAILED",
          "A damaged validation lease requires operator inspection before new runs.",
        );
      }
      if (
        lease.version !== 1 ||
        lease.backend !== "docker" ||
        !/^[a-f0-9-]{36}$/u.test(lease.label) ||
        lease.name !== `primitive-validation-${lease.label}` ||
        file !== `${lease.label}.json` ||
        !["creating", "created"].includes(lease.phase)
      )
        throw new RuntimeError(
          "CLEANUP_FAILED",
          "Validation lease identity is invalid.",
        );
      lease.file = absolute;
      await cleanupDockerLease(lease, executable, env);
      recovered.push(lease.name);
    }
    return { recovered };
  } finally {
    await removeTree(config);
  }
}
