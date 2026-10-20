import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  lstatSync,
  chmodSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { check, RuntimeError } from "../errors.js";
import { privateDirectory, readPrivateJSON } from "../util.js";

function checkMarker(directory: string, allowDeleting = false): void {
  const marker = readPrivateJSON(
    join(directory, ".primitive-runtime-state.json"),
  ) as Record<string, unknown>;
  check(
    marker.marker_version === 1 &&
      marker.product === "primitive-runtime" &&
      typeof marker.state_dir === "string" &&
      realpathSync.native(marker.state_dir) ===
        realpathSync.native(directory) &&
      [undefined, "active", "deleting"].includes(
        marker.state as string | undefined,
      ) &&
      (allowDeleting || marker.state !== "deleting"),
    "CONFIG_REQUIRED",
    "The state directory is uninitialized or is being removed.",
  );
}

/** Share the same exclusive ownership fence between serve and offline maintenance. */
export function acquireStateLock(
  directory: string,
  options: { allowDeleting?: boolean } = {},
): () => void {
  privateDirectory(directory);
  checkMarker(directory, options.allowDeleting);
  const lock = join(directory, "service.lock");
  const database = join(directory, "ownership.sqlite");
  for (const file of [database, lock])
    if (existsSync(file)) {
      const stat = lstatSync(file);
      check(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        "CONFIG_REQUIRED",
        "Invalid state ownership file.",
      );
    }
  const owner = new DatabaseSync(database);
  if (process.platform !== "win32") chmodSync(database, 0o600);
  try {
    owner.exec(
      "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL);",
    );
  } catch {
    owner.close();
    throw new RuntimeError(
      "SERVICE_RUNNING",
      "The state directory is owned by a running service or offline maintenance. Stop it before this operation.",
    );
  }
  try {
    checkMarker(directory, options.allowDeleting);
    owner
      .prepare("INSERT OR REPLACE INTO ownership VALUES(1,?)")
      .run(process.pid);
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
  } catch (error) {
    owner.exec("ROLLBACK");
    owner.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lock, "utf8").trim() === String(process.pid))
        unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
  };
}
