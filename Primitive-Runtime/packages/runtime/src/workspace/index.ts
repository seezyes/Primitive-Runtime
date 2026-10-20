import { constants, linkSync, renameSync, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeError } from "../errors.js";
import {
  artifactPath,
  canonicalRoot,
  decodeText,
  isWithin,
  openParent,
  readBytes,
} from "./paths.js";
import {
  copyManifest,
  hashBytes,
  hashManifest,
  makeReadonly,
  manifestForPaths,
  removeTree,
  scanManifest,
} from "./manifest.js";
import { cleanGitState, git } from "./git.js";
import type {
  Candidate,
  Manifest,
  Snapshot,
  WorkspaceLimits,
} from "./types.js";

export type {
  Candidate,
  Manifest,
  ManifestEntry,
  Snapshot,
  WorkspaceLimits,
} from "./types.js";
export { artifactPath, hashBytes, hashManifest, scanManifest };

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const mutations = new Map<string, Promise<void>>();

async function withMutation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  mutations.set(key, chain);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (mutations.get(key) === chain) mutations.delete(key);
  }
}

function checkLimits(limits: WorkspaceLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RuntimeError(
        "CONFIG_REQUIRED",
        "Workspace limits must be positive safe integers.",
      );
  }
}

export async function createSnapshot(
  workspacePath: string,
  destination: string,
  limits: WorkspaceLimits,
  signal?: AbortSignal,
): Promise<Snapshot> {
  checkLimits(limits);
  signal?.throwIfAborted();
  const source = await canonicalRoot(workspacePath);
  const top = await fs.realpath(
    (await git(source, ["rev-parse", "--show-toplevel"], [0], signal)).trim(),
  );
  if (top !== source)
    throw new RuntimeError(
      "WORKSPACE_UNAVAILABLE",
      "Workspace binding must point to a Git worktree root.",
    );
  const stage = path.resolve(destination);
  const baseline = `${stage}.baseline`;
  if (
    isWithin(source, stage) ||
    isWithin(stage, source) ||
    isWithin(source, baseline)
  ) {
    throw new RuntimeError(
      "INVALID_ARTIFACT_PATH",
      "Staging must be separate from the source workspace.",
    );
  }
  const before = await cleanGitState(source, signal);
  const manifest = await manifestForPaths(source, before.paths, limits, signal);
  let stageCreated = false;
  let baselineCreated = false;
  try {
    await fs.mkdir(path.dirname(stage), { recursive: true, mode: 0o700 });
    await fs.mkdir(stage, { mode: 0o700 });
    stageCreated = true;
    await fs.mkdir(baseline, { mode: 0o700 });
    baselineCreated = true;
    await copyManifest(source, stage, manifest, signal);
    await copyManifest(stage, baseline, manifest, signal);
    const snapshot: Snapshot = {
      root: stage,
      source_root: source,
      baseline_root: baseline,
      baseline_id: `baseline_${randomUUID()}`,
      git_head: before.head,
      manifest,
      candidate_hash: hashManifest(manifest),
      limits: { ...limits },
    };
    await assertWorkspaceUnchanged(snapshot);
    await makeReadonly(baseline);
    return snapshot;
  } catch (error) {
    if (stageCreated) await removeTree(stage);
    if (baselineCreated) await removeTree(baseline);
    throw error;
  }
}

export async function readArtifact(
  root: string,
  name: string,
  maxBytes: number,
): Promise<{ content: string; hash: string }> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > 256 * 1024 * 1024
  ) {
    throw new RuntimeError("BUDGET_EXCEEDED", "Invalid artifact read limit.");
  }
  try {
    const { bytes } = await readBytes(root, name, maxBytes);
    return { content: decodeText(bytes), hash: hashBytes(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new RuntimeError(
        "ARTIFACT_NOT_FOUND",
        "The artifact does not exist.",
      );
    throw error;
  }
}

export async function writeArtifact(
  root: string,
  name: string,
  content: string | null,
  expectedHash: string | null,
  beforeCommit?: () => void,
): Promise<{ hash: string | null; size: number }> {
  const relative = artifactPath(name);
  if (
    content !== null &&
    (typeof content !== "string" ||
      Buffer.byteLength(content) > MAX_ARTIFACT_BYTES)
  ) {
    throw new RuntimeError(
      "BUDGET_EXCEEDED",
      "Patch content exceeds the maximum artifact size.",
    );
  }
  if (
    content !== null &&
    decodeText(Buffer.from(content, "utf8")) !== content
  ) {
    throw new RuntimeError(
      "UNSUPPORTED_ARTIFACT",
      "Patch content is not well-formed UTF-8 text.",
    );
  }
  const base = await canonicalRoot(root);
  return withMutation(`${base}\0${relative}`, async () => {
    let previous: { bytes: Buffer; mode: number } | undefined;
    try {
      previous = await readBytes(base, relative, MAX_ARTIFACT_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((previous ? hashBytes(previous.bytes) : null) !== expectedHash)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Artifact hash does not match the proposal baseline.",
      );
    if (previous) decodeText(previous.bytes);
    if (!previous && content === null)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Cannot delete an artifact that does not exist.",
      );
    const parent = await openParent(base, relative, content !== null);
    const target = path.join(parent.anchored, parent.leaf);
    const temp = path.join(parent.anchored, `.primitive-write-${randomUUID()}`);
    let temporary = false;
    try {
      if (content !== null) {
        const handle = await fs.open(
          temp,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          previous?.mode ?? 0o644,
        );
        temporary = true;
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      let current: { bytes: Buffer; mode: number } | undefined;
      try {
        current = await readBytes(base, relative, MAX_ARTIFACT_BYTES);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if ((current ? hashBytes(current.bytes) : null) !== expectedHash)
        throw new RuntimeError(
          "PATCH_CONFLICT",
          "Artifact changed while the proposal was being prepared.",
        );
      await parent.verify();
      // The controller's generation fence and the mutation share an event-loop turn.
      // No cancellation callback can interleave between this check and commit.
      beforeCommit?.();
      if (content === null) unlinkSync(target);
      else {
        // A created artifact must never replace a concurrently created path.
        if (expectedHash === null) {
          linkSync(temp, target);
          unlinkSync(temp);
        } else renameSync(temp, target);
        temporary = false;
      }
      await parent.verify();
      return {
        hash: content === null ? null : hashBytes(content),
        size: content === null ? 0 : Buffer.byteLength(content),
      };
    } finally {
      if (temporary) await fs.unlink(temp).catch(() => undefined);
      await parent.close();
    }
  });
}

export async function assertWorkspaceUnchanged(
  snapshot: Snapshot,
): Promise<void> {
  try {
    const state = await cleanGitState(snapshot.source_root);
    const current = await manifestForPaths(
      snapshot.source_root,
      state.paths,
      snapshot.limits,
    );
    if (
      state.head !== snapshot.git_head ||
      hashManifest(current) !== hashManifest(snapshot.manifest)
    ) {
      throw new RuntimeError(
        "WORKSPACE_CONFLICT",
        "The source workspace changed after this run was admitted.",
      );
    }
  } catch (error) {
    if ((error as { code?: string }).code === "WORKSPACE_CONFLICT") throw error;
    throw new RuntimeError(
      "WORKSPACE_CONFLICT",
      "The source workspace is no longer the admitted clean baseline.",
    );
  }
}

async function createDiff(
  snapshot: Snapshot,
  candidateRoot: string,
  manifest: Manifest,
  changed: string[],
  parent: string,
): Promise<string> {
  if (!changed.length) return "";
  const temp = await fs.mkdtemp(path.join(parent, ".diff-"));
  try {
    const a = path.join(temp, "a");
    const b = path.join(temp, "b");
    await fs.mkdir(a);
    await fs.mkdir(b);
    for (const name of changed) {
      const old = Object.hasOwn(snapshot.manifest, name)
        ? snapshot.manifest[name]
        : undefined;
      const next = Object.hasOwn(manifest, name) ? manifest[name] : undefined;
      for (const [entry, source, target] of [
        [old, snapshot.baseline_root, a],
        [next, candidateRoot, b],
      ] as const) {
        if (!entry) continue;
        const { bytes } = await readBytes(
          source,
          name,
          snapshot.limits.max_file_bytes,
        );
        decodeText(bytes);
        const file = path.join(target, name);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, bytes, { flag: "wx", mode: entry.mode });
        await fs.chmod(file, entry.mode);
      }
    }
    return await git(
      temp,
      [
        "diff",
        "--no-index",
        "--no-prefix",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--",
        "a",
        "b",
      ],
      [0, 1],
    );
  } finally {
    await removeTree(temp);
  }
}

export async function freezeCandidate(
  snapshot: Snapshot,
  destination: string,
): Promise<Candidate> {
  await assertWorkspaceUnchanged(snapshot);
  const manifest = await scanManifest(snapshot.root, snapshot.limits);
  if (
    hashManifest(
      await scanManifest(snapshot.baseline_root, snapshot.limits),
    ) !== hashManifest(snapshot.manifest)
  ) {
    throw new RuntimeError(
      "PATCH_CONFLICT",
      "The immutable baseline has been changed.",
    );
  }
  const names = new Set([
    ...Object.keys(snapshot.manifest),
    ...Object.keys(manifest),
  ]);
  const changed = [...names]
    .filter(
      (name) =>
        JSON.stringify(
          Object.hasOwn(snapshot.manifest, name)
            ? snapshot.manifest[name]
            : undefined,
        ) !==
        JSON.stringify(
          Object.hasOwn(manifest, name) ? manifest[name] : undefined,
        ),
    )
    .sort();
  const root = path.resolve(destination);
  if (
    isWithin(snapshot.root, root) ||
    isWithin(root, snapshot.root) ||
    isWithin(snapshot.source_root, root)
  ) {
    throw new RuntimeError(
      "INVALID_ARTIFACT_PATH",
      "Candidate must be separate from source and mutable staging.",
    );
  }
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  try {
    await copyManifest(snapshot.root, root, manifest);
    if (
      hashManifest(await scanManifest(snapshot.root, snapshot.limits)) !==
      hashManifest(manifest)
    ) {
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Staging changed while the candidate was frozen.",
      );
    }
    const diff = await createDiff(
      snapshot,
      root,
      manifest,
      changed,
      path.dirname(root),
    );
    await makeReadonly(root);
    return {
      root,
      hash: hashManifest(manifest),
      files_changed: changed,
      diff,
      manifest,
    };
  } catch (error) {
    await removeTree(root);
    throw error;
  }
}
