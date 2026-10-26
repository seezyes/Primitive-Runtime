import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { RuntimeError } from "../errors.js";

const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function caseKey(value: string): string {
  return value.toUpperCase().toLowerCase();
}

/** Repository identities deliberately use the portable, unambiguous subset of paths. */
export function artifactPath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value !== value.normalize("NFC") ||
    /[\x00-\x1f\x7f\\:<>"|?*]/u.test(value) ||
    value.startsWith("/")
  ) {
    throw new RuntimeError(
      "INVALID_ARTIFACT_PATH",
      "Artifact paths must be normalized, relative repository paths.",
    );
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /[ .]$/u.test(part) ||
        reserved.test(part),
    )
  ) {
    throw new RuntimeError(
      "INVALID_ARTIFACT_PATH",
      "Artifact path contains a reserved or ambiguous component.",
    );
  }
  return parts.join("/");
}

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertNoCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of paths) {
    const components = artifactPath(name).split("/");
    for (let count = 1; count <= components.length; count++) {
      const item = components.slice(0, count).join("/");
      const key = caseKey(item);
      const previous = seen.get(key);
      if (previous !== undefined && previous !== item) {
        throw new RuntimeError(
          "UNSUPPORTED_ARTIFACT",
          "Case-colliding artifact paths are unsupported.",
        );
      }
      seen.set(key, item);
    }
  }
}

export async function canonicalRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RuntimeError(
      "UNSUPPORTED_ARTIFACT",
      "Workspace root must be a real directory, not a link.",
    );
  }
  return fs.realpath(absolute);
}

function sameIdentity(
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export interface ParentHandle {
  /** Linux anchors operations to an open directory, avoiding parent-symlink races. */
  anchored: string;
  leaf: string;
  verify(): Promise<void>;
  close(): Promise<void>;
}

/**
 * All data-plane filesystem access walks directories without following symlinks.
 * Linux additionally uses kernel-held directory descriptors for check/use safety.
 * On other platforms the same identity is checked immediately before and after I/O;
 * an attacker controlling the service's OS account remains outside the trust boundary.
 */
export async function openParent(
  root: string,
  relative: string,
  create = false,
): Promise<ParentHandle> {
  const name = artifactPath(relative);
  const base = await canonicalRoot(root);
  const parts = name.split("/");
  const leaf = parts.pop()!;
  const handles: FileHandle[] = [];
  const identities: Array<{ path: string; dev: number; ino: number }> = [];
  let current = base;
  try {
    const openDirectory = async (
      directory: string,
      realName: string,
    ): Promise<string> => {
      const before = await fs.lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new RuntimeError(
          "UNSUPPORTED_ARTIFACT",
          "Linked or non-directory artifact parents are not allowed.",
        );
      }
      identities.push({ path: realName, dev: before.dev, ino: before.ino });
      if (process.platform !== "linux") return directory;
      const handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      const after = await handle.stat();
      if (!sameIdentity(before, after))
        throw new RuntimeError(
          "PATCH_CONFLICT",
          "Artifact parent changed while opening it.",
        );
      return `/proc/self/fd/${handle.fd}`;
    };
    let anchored = await openDirectory(base, base);
    for (const part of parts) {
      const entries = await fs.readdir(anchored);
      if (
        entries.some(
          (entry) => caseKey(entry) === caseKey(part) && entry !== part,
        )
      ) {
        throw new RuntimeError(
          "UNSUPPORTED_ARTIFACT",
          "Artifact path collides with an existing path.",
        );
      }
      const next = path.join(anchored, part);
      if (create) {
        try {
          await fs.mkdir(next, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      current = path.join(current, part);
      anchored = await openDirectory(next, current);
    }
    const entries = await fs.readdir(anchored);
    if (
      entries.some(
        (entry) => caseKey(entry) === caseKey(leaf) && entry !== leaf,
      )
    ) {
      throw new RuntimeError(
        "UNSUPPORTED_ARTIFACT",
        "Artifact path collides with an existing path.",
      );
    }
    return {
      anchored,
      leaf,
      async verify() {
        for (const item of identities) {
          const currentStat = await fs.lstat(item.path);
          if (
            currentStat.isSymbolicLink() ||
            !currentStat.isDirectory() ||
            !sameIdentity(item, currentStat)
          ) {
            throw new RuntimeError(
              "PATCH_CONFLICT",
              "Artifact parent changed during filesystem access.",
            );
          }
        }
      },
      async close() {
        await Promise.all(handles.map((handle) => handle.close()));
      },
    };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

export async function readBytes(
  root: string,
  name: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; mode: number }> {
  const parent = await openParent(root, name);
  let file: FileHandle | undefined;
  try {
    const target = path.join(parent.anchored, parent.leaf);
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new RuntimeError(
        "UNSUPPORTED_ARTIFACT",
        "Only regular, singly linked files are supported.",
      );
    }
    if (before.size > maxBytes)
      throw new RuntimeError(
        "BUDGET_EXCEEDED",
        "Artifact exceeds the configured file-size limit.",
      );
    file = await fs.open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await file.stat();
    if (!sameIdentity(before, opened) || opened.nlink !== 1)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Artifact changed while opening it.",
      );
    await parent.verify();
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    let used = 0;
    while (used < bytes.length) {
      const chunk = await file.read(bytes, used, bytes.length - used, used);
      if (!chunk.bytesRead) break;
      used += chunk.bytesRead;
    }
    const after = await file.stat();
    const current = await fs.lstat(target);
    await parent.verify();
    if (
      !sameIdentity(opened, current) ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      used !== after.size
    ) {
      throw new RuntimeError(
        "PATCH_CONFLICT",
        "Artifact changed while it was being read.",
      );
    }
    if (used > maxBytes)
      throw new RuntimeError(
        "BUDGET_EXCEEDED",
        "Artifact exceeds the configured file-size limit.",
      );
    return {
      bytes: bytes.subarray(0, used),
      mode: after.mode & 0o111 ? 0o755 : 0o644,
    };
  } finally {
    await file?.close();
    await parent.close();
  }
}

export function decodeText(bytes: Buffer): string {
  try {
    if (bytes.includes(0)) throw new Error("binary");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new RuntimeError(
      "UNSUPPORTED_ARTIFACT",
      "Binary and non-UTF-8 artifact edits are unsupported.",
    );
  }
}
