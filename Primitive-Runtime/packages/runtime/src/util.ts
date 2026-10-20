import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  lstatSync,
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { RuntimeError, check } from "./errors.js";
export function hash(value: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
export function identifier(prefix: string): string {
  return prefix + "_" + randomBytes(12).toString("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function equalSecret(a: string, b: string): boolean {
  const aa = Buffer.from(hash(a));
  const bb = Buffer.from(hash(b));
  return timingSafeEqual(aa, bb);
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  check(
    st.isDirectory() && !st.isSymbolicLink(),
    "CONFIG_REQUIRED",
    "State directory must be a real private directory.",
  );
  if (process.platform !== "win32") {
    check(
      st.uid === process.getuid!(),
      "ACCESS_DENIED",
      "State directory is owned by a different user.",
    );
    chmodSync(path, 0o700);
  }
}
export function atomicJSON(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temp = path + "." + randomBytes(6).toString("hex") + ".tmp";
  let committed = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    committed = true;
    if (process.platform !== "win32") {
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
  } catch (error) {
    if (committed)
      throw new RuntimeError(
        "CONFIG_DURABILITY_UNCONFIRMED",
        "The file was replaced, but filesystem durability could not be confirmed. Inspect the saved state before retrying.",
      );
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}
export function readPrivateJSON(path: string): unknown {
  const st = lstatSync(path);
  check(
    st.isFile() && !st.isSymbolicLink() && st.nlink === 1,
    "CONFIG_REQUIRED",
    "Configuration must be a regular, unlinked file.",
  );
  if (process.platform !== "win32")
    check(
      st.uid === process.getuid!() && (st.mode & 0o077) === 0,
      "ACCESS_DENIED",
      "Configuration and credential files require owner-only permissions (chmod 600).",
    );
  check(
    st.size < 4 * 1024 * 1024,
    "CONFIG_REQUIRED",
    "Configuration is too large.",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}
export function readCredential(ref?: string): string | undefined {
  if (!ref) return undefined;
  let value: string | undefined;
  if (ref.startsWith("env:")) value = process.env[ref.slice(4)];
  else if (ref.startsWith("file:")) {
    const path = ref.slice(5);
    check(
      isAbsolute(path),
      "CONFIG_REQUIRED",
      "Credential file must be absolute.",
    );
    const st = lstatSync(path);
    check(
      st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 16384,
      "CONFIG_REQUIRED",
      "Invalid credential file.",
    );
    if (process.platform !== "win32")
      check(
        st.uid === process.getuid!() && (st.mode & 0o077) === 0,
        "ACCESS_DENIED",
        "Credential file requires owner-only permissions.",
      );
    value = readFileSync(path, "utf8").trim();
  } else
    throw new RuntimeError(
      "CONFIG_REQUIRED",
      "Use an env:NAME or file:absolute-path credential reference.",
    );
  check(
    value && value.length <= 16384 && !/[\r\n]/.test(value),
    "CONFIG_REQUIRED",
    "A required credential is missing or invalid.",
  );
  return value;
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
