import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { createConnection } from "node:net";
import { Configuration } from "../../dist/runtime/src/control/config.js";
import { acquireStateLock } from "../../dist/runtime/src/control/state-lock.js";
import { atomicJSON, readPrivateJSON } from "../../dist/runtime/src/util.js";
import { recoverValidationLeases } from "../../dist/runtime/src/validation/index.js";
import { requireValue } from "./release.mjs";

const MARKER = ".primitive-runtime-state.json";
const DIRECTORY_ENTRIES = new Set(["runs", "doctor-leases"]);
const FILE_ENTRIES = new Set([
  MARKER,
  "operator.json",
  "operator-client.json",
  "service.lock",
  "runtime.sqlite",
  "runtime.sqlite-wal",
  "runtime.sqlite-shm",
  "runtime.sqlite-journal",
  "ownership.sqlite",
  "ownership.sqlite-wal",
  "ownership.sqlite-shm",
  "ownership.sqlite-journal",
]);
const identity = (value) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const contains = (parent, child) => {
  const base = identity(parent);
  return (
    identity(child) === base ||
    identity(child).startsWith(base.endsWith(sep) ? base : base + sep)
  );
};

export function dedicatedStatePath(directory) {
  requireValue(
    typeof directory === "string" && isAbsolute(directory),
    "Use an absolute dedicated runtime state directory.",
  );
  const root = resolve(directory);
  requireValue(
    identity(root) !== identity(parse(root).root) &&
      identity(root) !== identity(homedir()),
    "A filesystem root or home directory cannot be runtime state.",
  );
  let current = root;
  while (!existsSync(current)) current = resolve(current, "..");
  requireValue(
    identity(realpathSync(current)) === identity(current),
    "Runtime state paths must not traverse symlinks or junctions.",
  );
  if (existsSync(root)) {
    const stat = lstatSync(root);
    requireValue(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Runtime state must be a real directory.",
    );
  }
  return root;
}

function regular(stat, name) {
  requireValue(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    "Unexpected linked or non-file runtime entry: " + name,
  );
}

/** Never turn a mutable configuration path into permission to recursively rm it. */
export function inspectStateOwnership(directory) {
  const root = dedicatedStatePath(directory);
  const rootStat = lstatSync(root);
  const marker = readPrivateJSON(join(root, MARKER));
  requireValue(
    marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      Object.keys(marker)
        .filter((key) => key !== "state")
        .sort()
        .join(",") ===
        "created_at,instance_id,marker_version,product,state_dir" &&
      marker.marker_version === 1 &&
      marker.product === "primitive-runtime" &&
      (marker.state === undefined ||
        ["active", "deleting"].includes(marker.state)) &&
      /^instance_[a-f0-9]{24}$/u.test(marker.instance_id) &&
      Number.isFinite(Date.parse(marker.created_at)) &&
      identity(marker.state_dir) === identity(root),
    "The dedicated runtime ownership marker is missing or invalid.",
  );
  const config = existsSync(join(root, "operator.json"))
    ? new Configuration(join(root, "operator.json")).current
    : null;
  requireValue(
    config
      ? identity(config.state_dir) === identity(root)
      : marker.state === "deleting",
    "Configuration does not bind this dedicated state directory.",
  );
  for (const workspace of Object.values(config?.workspaces ?? {})) {
    const candidates = [resolve(workspace.path)];
    if (existsSync(workspace.path))
      candidates.push(realpathSync(workspace.path));
    requireValue(
      candidates.every(
        (source) => !contains(root, source) && !contains(source, root),
      ),
      "Runtime state overlaps a configured workspace; uninstall requires operator inspection.",
    );
  }
  if (config && process.platform !== "win32")
    requireValue(
      identity(config.socket_path) === identity(join(root, "runtime.sock")),
      "Unexpected IPC socket location in runtime state.",
    );
  const entries = readdirSync(root).sort();
  for (const name of entries) {
    const stat = lstatSync(join(root, name));
    if (DIRECTORY_ENTRIES.has(name))
      requireValue(
        stat.isDirectory() && !stat.isSymbolicLink(),
        "Unexpected runtime directory type: " + name,
      );
    else if (name === "runtime.sock" && process.platform !== "win32")
      requireValue(
        stat.isSocket() && !stat.isSymbolicLink(),
        "Unexpected IPC socket type.",
      );
    else {
      requireValue(
        FILE_ENTRIES.has(name),
        "Unrecognized state entry will not be deleted: " + name,
      );
      regular(stat, name);
    }
  }
  return { root, rootStat, marker, config, entries };
}

async function socketLive(socketPath) {
  return new Promise((resolveLive) => {
    let done = false;
    const socket = createConnection(socketPath);
    const finish = (live) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveLive(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) =>
      finish(!["ENOENT", "ECONNREFUSED"].includes(error.code)),
    );
    socket.setTimeout(1000, () => finish(true));
  });
}

function inventoryTree(root) {
  const result = [],
    pending = [root];
  while (pending.length) {
    const target = pending.pop(),
      stat = lstatSync(target);
    requireValue(
      !stat.isSymbolicLink(),
      "Refusing a symlink or junction inside runtime state.",
    );
    if (stat.isDirectory())
      for (const name of readdirSync(target)) pending.push(join(target, name));
    else regular(stat, target);
    result.push({ target, stat });
    requireValue(
      result.length <= 1_000_000,
      "Runtime state needs manual inspection before this bounded uninstall.",
    );
  }
  return result;
}

function removeInventoriedTree(root) {
  const entries = inventoryTree(root);
  for (const { target, stat } of entries) {
    const current = lstatSync(target);
    requireValue(
      current.dev === stat.dev &&
        current.ino === stat.ino &&
        !current.isSymbolicLink(),
      "Runtime state changed during uninstall.",
    );
    if (stat.isDirectory()) chmodSync(target, 0o700);
  }
  for (const { target, stat } of entries.reverse()) {
    const current = lstatSync(target);
    requireValue(
      current.dev === stat.dev &&
        current.ino === stat.ino &&
        !current.isSymbolicLink(),
      "Runtime state changed during uninstall.",
    );
    if (stat.isDirectory()) rmdirSync(target);
    else unlinkSync(target);
  }
}

export async function uninstallRuntime(directory) {
  const before = inspectStateOwnership(directory);
  const releaseLock = acquireStateLock(before.root, { allowDeleting: true });
  try {
    const state = inspectStateOwnership(before.root);
    requireValue(
      state.marker.instance_id === before.marker.instance_id &&
        state.rootStat.dev === before.rootStat.dev &&
        state.rootStat.ino === before.rootStat.ino,
      "Runtime ownership changed before uninstall.",
    );
    if (state.config)
      requireValue(
        !(await socketLive(state.config.socket_path)),
        "A service is listening; stop it before uninstalling.",
      );
    atomicJSON(join(state.root, MARKER), {
      ...state.marker,
      state: "deleting",
    });
    const recovered = [];
    recovered.push(
      ...(await recoverValidationLeases(join(state.root, "doctor-leases")))
        .recovered,
    );
    const runs = join(state.root, "runs");
    if (existsSync(runs)) {
      // Inspect every owned run directory, including a receipt whose database
      // transaction was interrupted. An absent row is not cleanup evidence.
      inventoryTree(runs);
      for (const name of readdirSync(runs)) {
        requireValue(
          /^pr_run_[a-f0-9]{24}$/u.test(name) &&
            lstatSync(join(runs, name)).isDirectory(),
          "Unrecognized runtime run directory.",
        );
        recovered.push(
          ...(
            await recoverValidationLeases(join(runs, name, "validation-leases"))
          ).recovered,
        );
      }
    }
    const ready = inspectStateOwnership(state.root);
    requireValue(
      ready.marker.instance_id === state.marker.instance_id,
      "Runtime ownership changed during cleanup.",
    );
    const protectedNames = new Set([
      MARKER,
      "operator.json",
      "operator-client.json",
      "service.lock",
      "ownership.sqlite",
      "ownership.sqlite-wal",
      "ownership.sqlite-shm",
      "ownership.sqlite-journal",
    ]);
    for (const name of ready.entries) {
      if (protectedNames.has(name)) continue;
      const target = join(state.root, name);
      if (DIRECTORY_ENTRIES.has(name)) removeInventoriedTree(target);
      else unlinkSync(target);
    }
    // Configuration and the ownership marker remain until all worker cleanup
    // and artifact deletion succeeded, so an interrupted removal is reviewable.
    for (const name of ["operator-client.json", "operator.json"])
      if (existsSync(join(state.root, name)))
        unlinkSync(join(state.root, name));
    releaseLock();
    for (const name of protectedNames)
      if (name !== MARKER && existsSync(join(state.root, name)))
        unlinkSync(join(state.root, name));
    unlinkSync(join(state.root, MARKER));
    rmdirSync(state.root);
    return {
      removed: true,
      state_dir: state.root,
      recovered_validation_containers: recovered,
    };
  } finally {
    releaseLock();
  }
}
