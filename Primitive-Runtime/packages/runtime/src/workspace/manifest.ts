import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeError } from "../errors.js";
import {
  artifactPath,
  assertNoCaseCollisions,
  canonicalRoot,
  readBytes,
} from "./paths.js";
import type { Manifest, WorkspaceLimits } from "./types.js";

export function hashBytes(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashManifest(manifest: Manifest): string {
  return hashBytes(
    JSON.stringify(
      Object.keys(manifest)
        .sort()
        .map((name) => [name, manifest[name]]),
    ),
  );
}

export async function scanManifest(
  root: string,
  limits: WorkspaceLimits,
  signal?: AbortSignal,
): Promise<Manifest> {
  const base = await canonicalRoot(root);
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await fs.readdir(path.join(base, relative), {
      withFileTypes: true,
    })) {
      const name = artifactPath(
        relative ? `${relative}/${entry.name}` : entry.name,
      );
      if (entry.isSymbolicLink())
        throw new RuntimeError(
          "UNSUPPORTED_ARTIFACT",
          "Snapshot links are unsupported.",
        );
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else
        throw new RuntimeError(
          "UNSUPPORTED_ARTIFACT",
          "Snapshot contains a non-regular artifact.",
        );
      if (files.length > limits.max_files)
        throw new RuntimeError(
          "BUDGET_EXCEEDED",
          "Workspace file count exceeds the configured limit.",
        );
    }
  };
  await walk("");
  return manifestForPaths(base, files, limits, signal);
}

export async function manifestForPaths(
  root: string,
  names: readonly string[],
  limits: WorkspaceLimits,
  signal?: AbortSignal,
): Promise<Manifest> {
  if (names.length > limits.max_files)
    throw new RuntimeError(
      "BUDGET_EXCEEDED",
      "Workspace file count exceeds the configured limit.",
    );
  assertNoCaseCollisions(names);
  const result: Manifest = Object.create(null) as Manifest;
  let total = 0;
  for (const name of [...names].sort()) {
    signal?.throwIfAborted();
    const { bytes, mode } = await readBytes(root, name, limits.max_file_bytes);
    total += bytes.length;
    if (total > limits.max_workspace_bytes)
      throw new RuntimeError(
        "BUDGET_EXCEEDED",
        "Workspace size exceeds the configured limit.",
      );
    result[name] = { hash: hashBytes(bytes), size: bytes.length, mode };
  }
  return result;
}

export async function copyManifest(
  source: string,
  destination: string,
  manifest: Manifest,
  signal?: AbortSignal,
): Promise<void> {
  for (const [name, expected] of Object.entries(manifest)) {
    signal?.throwIfAborted();
    const { bytes, mode } = await readBytes(source, name, expected.size);
    if (hashBytes(bytes) !== expected.hash || mode !== expected.mode)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Snapshot changed during copying.",
      );
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: "wx", mode });
    await fs.chmod(target, mode);
  }
}

export async function makeReadonly(root: string): Promise<void> {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, item.name);
    if (item.isDirectory()) await makeReadonly(target);
    else {
      const stat = await fs.lstat(target);
      await fs.chmod(target, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
  await fs.chmod(root, 0o555);
}

export async function removeTree(root: string): Promise<void> {
  try {
    await fs.chmod(root, 0o700);
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      if (item.isDirectory() && !item.isSymbolicLink())
        await removeTree(path.join(root, item.name));
      else await fs.unlink(path.join(root, item.name));
    }
    await fs.rmdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
