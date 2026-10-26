import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";

export const RELEASE_PLATFORMS = ["linux-x64", "win32-x64"];
export const REQUIRED_GATES = [
  "standalone_mcp",
  "file_ownership",
  "restart_policy",
  "in_round_messaging",
  "quiescence_race",
  "snapshot_conflict",
  "validation_truth",
  "lifecycle",
  "isolation",
  "contracts",
  "packaging",
];
export const UPSTREAM_COMMIT = "774613c90751b6a26ae9eb6a27be6aff3f210062";
const SHA = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const own = (object, key) => Object.hasOwn(object, key);

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, name, required, optional = []) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object.`,
  );
  const keys = new Set([...required, ...optional]);
  requireValue(
    required.every((key) => own(value, key)) &&
      Object.keys(value).every((key) => keys.has(key)),
    `${name} has missing or unknown fields.`,
  );
  return value;
}

function text(value, name, maximum = 256) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      !/[\u0000-\u001f]/u.test(value),
    `Invalid ${name}.`,
  );
}

function timestamp(value, name) {
  text(value, name, 40);
  requireValue(
    /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value)),
    `Invalid ${name}.`,
  );
}

export function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export function readRegularFile(
  file,
  maximum = 512 * 1024 * 1024,
  allowHardlinks = false,
) {
  const before = lstatSync(file);
  requireValue(
    before.isFile() &&
      !before.isSymbolicLink() &&
      (allowHardlinks || before.nlink === 1) &&
      before.size <= maximum,
    "Expected a bounded regular release file: " + file,
  );
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireValue(
      opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size,
      "Release file changed before opening: " + file,
    );
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    requireValue(
      after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        bytes.length === before.size,
      "Release file changed while reading: " + file,
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function readJSON(file) {
  return JSON.parse(readRegularFile(file, 1024 * 1024).toString("utf8"));
}

export function filename(name) {
  requireValue(
    typeof name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(name) &&
      !name.endsWith("."),
    "Invalid release artifact filename.",
  );
  return name;
}

export function inspectNative(binary) {
  // Cargo creates its release binary as a hard link into target/release/deps.
  // Read it without modifying either link; emitted product copies are separate.
  const bytes = readRegularFile(binary, undefined, true);
  const env =
    process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT }
      : {};
  const output = execFileSync(binary, ["version", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  const metadata = JSON.parse(output);
  requireValue(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      metadata.name === "jcode-primitive" &&
      VERSION.test(metadata.version) &&
      metadata.engine_protocol === "primitive-engine/1" &&
      metadata.policy_revision === "primitive-policy/1" &&
      metadata.turn_core_protocol === "jcode-turn/1" &&
      metadata.shared_ordinary_turn_core === true &&
      metadata.upstream_commit === UPSTREAM_COMMIT &&
      metadata.restricted_mode === true &&
      metadata.ordinary_tools === false &&
      metadata.ambient_credentials === false,
    "The native binary did not acknowledge the pinned restricted engine contract.",
  );
  requireValue(
    sha256(readRegularFile(binary, undefined, true)) === sha256(bytes),
    "Native binary changed during inspection.",
  );
  return { ...metadata, sha256: sha256(bytes) };
}

export function sourceState(root) {
  try {
    const args = {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const revision = execFileSync(
      "git",
      ["--no-optional-locks", "rev-parse", "HEAD"],
      args,
    ).trim();
    requireValue(
      COMMIT.test(revision),
      "Git did not return an exact source revision.",
    );
    const visible = execFileSync(
      "git",
      ["--no-optional-locks", "ls-files", "-v", "-z"],
      args,
    )
      .split("\0")
      .filter(Boolean)
      .every((entry) => entry.startsWith("H "));
    const clean =
      visible &&
      execFileSync(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "status",
          "--porcelain",
          "--untracked-files=all",
        ],
        args,
      ).trim() === "";
    return {
      revision,
      clean,
      source_revision: clean ? revision : revision + "-dirty",
    };
  } catch {
    return {
      revision: null,
      clean: false,
      source_revision: "uncommitted-source",
    };
  }
}

function acceptance(value, expected, allowReportPaths) {
  object(value, "acceptance evidence", [
    "evidence_version",
    "source_revision",
    "runtime_version",
    "contract_version",
    "platform",
    "engine_sha256",
    "node_major",
    "recorded_at",
    "isolation_backend",
    "gates",
    "review",
  ]);
  requireValue(
    value.evidence_version === 1 && COMMIT.test(value.source_revision),
    "Acceptance evidence requires an exact source revision.",
  );
  requireValue(
    value.source_revision === expected.source_revision &&
      value.runtime_version === expected.runtime_version &&
      value.contract_version === expected.contract_version &&
      value.platform === expected.platform &&
      value.engine_sha256 === expected.engine_sha256 &&
      SHA.test(value.engine_sha256),
    "Acceptance evidence does not match this source, platform, version, or engine binary.",
  );
  requireValue(
    value.node_major === 24,
    "Acceptance evidence must test Node.js 24.",
  );
  timestamp(value.recorded_at, "acceptance timestamp");
  requireValue(
    ["bwrap", "docker"].includes(value.isolation_backend) &&
      (value.platform !== "win32-x64" || value.isolation_backend === "docker"),
    "The platform requires a tested real isolation backend.",
  );
  requireValue(
    Array.isArray(value.gates) && value.gates.length === REQUIRED_GATES.length,
    "Every standalone acceptance gate needs explicit evidence.",
  );
  const ids = new Set();
  for (const gate of value.gates) {
    object(gate, "acceptance gate", [
      "id",
      "status",
      "report_file",
      "report_sha256",
    ]);
    requireValue(
      REQUIRED_GATES.includes(gate.id) &&
        !ids.has(gate.id) &&
        gate.status === "passed" &&
        SHA.test(gate.report_sha256),
      "Missing, duplicate, failed, skipped, or invalid acceptance gate.",
    );
    ids.add(gate.id);
    if (allowReportPaths) reportPath(gate.report_file);
    else filename(gate.report_file);
  }
  object(value.review, "review", [
    "status",
    "reviewer",
    "source_revision",
    "reviewed_at",
    "report_file",
    "report_sha256",
  ]);
  text(value.review.reviewer, "reviewer identity");
  requireValue(
    value.review.status === "approved" &&
      value.review.source_revision === value.source_revision &&
      SHA.test(value.review.report_sha256),
    "An approved review of the exact source revision is required.",
  );
  timestamp(value.review.reviewed_at, "review timestamp");
  if (allowReportPaths) reportPath(value.review.report_file);
  else filename(value.review.report_file);
  return value;
}

function reportPath(name) {
  text(name, "evidence report path", 1024);
  requireValue(
    !isAbsolute(name) &&
      !/[\\:]/u.test(name) &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    "Evidence reports must use controlled relative paths.",
  );
  return name;
}

function readReport(root, name) {
  const target = resolve(root, reportPath(name));
  requireValue(
    target.startsWith(resolve(root) + sep),
    "Evidence report escaped its directory.",
  );
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireValue(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Evidence directory must not be a symlink.",
    );
  }
  requireValue(
    realpathSync(dirname(target)) === realpathSync(root) ||
      realpathSync(dirname(target)).startsWith(realpathSync(root) + sep),
    "Evidence directory escaped its root.",
  );
  const bytes = readRegularFile(target, 32 * 1024 * 1024);
  requireValue(bytes.length > 0, "Acceptance reports must not be empty.");
  return bytes;
}

/** A reviewer supplies observed evidence; the packager never infers passing gates. */
export function loadAcceptance(file, expected) {
  const supplied = acceptance(readJSON(file), expected, true);
  const value = structuredClone(supplied),
    files = [];
  const root = dirname(resolve(file));
  const seen = new Map();
  for (const item of [...value.gates, value.review]) {
    const bytes = readReport(root, item.report_file);
    requireValue(
      sha256(bytes) === item.report_sha256,
      "Acceptance report hash does not match the reviewed evidence.",
    );
    const key =
      item === value.review
        ? "review:" + item.report_sha256
        : item.report_sha256;
    let name = seen.get(key);
    if (!name) {
      name =
        (item === value.review ? "review-report-" : "acceptance-report-") +
        files.length +
        ".txt";
      files.push({
        name,
        role: item === value.review ? "review-report" : "acceptance-report",
        sha256: item.report_sha256,
        size: bytes.length,
        bytes,
      });
      seen.set(key, name);
    }
    item.report_file = name;
  }
  return { evidence: value, files };
}

export function assertReleaseReady(source, engine, evidence) {
  requireValue(
    source.clean === true && COMMIT.test(source.revision),
    "Signed releases require a clean Git tree and an exact 40-character reviewed source revision.",
  );
  requireValue(
    engine.source_revision === source.revision,
    "Native engine must be built from the same reviewed source revision.",
  );
  requireValue(
    evidence !== null && evidence !== undefined,
    "Signed releases require explicit reviewed platform acceptance evidence.",
  );
}

export function validateManifest(value, signedOnly = true) {
  object(value, "release manifest", [
    "manifest_version",
    "runtime_version",
    "contract_version",
    "mcp_versions",
    "platform",
    "source_revision",
    "engine",
    "files",
    "acceptance",
    "trust",
  ], ["evidence_visibility"]);
  requireValue(
    value.manifest_version === 1 &&
      VERSION.test(value.runtime_version) &&
      value.contract_version === "primitive-runtime/0.1",
    "Unsupported release manifest or runtime contract version.",
  );
  requireValue(
    RELEASE_PLATFORMS.includes(value.platform) &&
      Array.isArray(value.mcp_versions) &&
      value.mcp_versions.length === 1 &&
      value.mcp_versions[0] === "2025-06-18",
    "Unsupported platform or MCP baseline.",
  );
  requireValue(
    value.engine &&
      typeof value.engine === "object" &&
      !Array.isArray(value.engine) &&
      value.engine.name === "jcode-primitive" &&
      VERSION.test(value.engine.version) &&
      SHA.test(value.engine.sha256) &&
      value.engine.engine_protocol === "primitive-engine/1" &&
      value.engine.policy_revision === "primitive-policy/1" &&
      value.engine.turn_core_protocol === "jcode-turn/1" &&
      value.engine.shared_ordinary_turn_core === true &&
      value.engine.upstream_commit === UPSTREAM_COMMIT &&
      value.engine.restricted_mode === true &&
      value.engine.ordinary_tools === false &&
      value.engine.ambient_credentials === false,
    "Manifest native engine contract is invalid.",
  );
  requireValue(
    Array.isArray(value.files) &&
      value.files.length > 0 &&
      value.files.length <= 32,
    "Manifest must contain release artifacts.",
  );
  const files = new Map();
  for (const file of value.files) {
    object(file, "release artifact", ["name", "role", "sha256", "size"]);
    filename(file.name);
    requireValue(
      !files.has(file.name.toLowerCase()) &&
        ["package", "acceptance-report", "review-report"].includes(file.role) &&
        SHA.test(file.sha256) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        file.size <= 512 * 1024 * 1024,
      "Invalid or duplicate release artifact.",
    );
    files.set(file.name.toLowerCase(), file);
  }
  const packages = value.files.filter((file) => file.role === "package");
  requireValue(
    packages.length === 1 && packages[0].name.endsWith(".tgz"),
    "Manifest must identify exactly one npm package.",
  );
  object(
    value.trust,
    "publisher trust",
    ["kind", "release_eligible"],
    ["publisher_key_id"],
  );
  const signed = value.trust.kind === "ed25519";
  requireValue(
    (signed || value.trust.kind === "unsigned-development") &&
      typeof value.trust.release_eligible === "boolean",
    "Invalid publisher trust declaration.",
  );
  if (signedOnly || signed) {
    requireValue(
      signed &&
        value.trust.release_eligible === true &&
        COMMIT.test(value.source_revision) &&
        value.engine.source_revision === value.source_revision,
      "Release is unsigned, unreviewed, or lacks exact source provenance.",
    );
    text(value.trust.publisher_key_id, "publisher key ID", 160);
    acceptance(
      value.acceptance,
      {
        source_revision: value.source_revision,
        runtime_version: value.runtime_version,
        contract_version: value.contract_version,
        platform: value.platform,
        engine_sha256: value.engine.sha256,
      },
      false,
    );
    // Report contents are validated against their hashes before signing, but
    // private review artifacts are NOT distributed with the product. The
    // signed manifest is a publisher attestation of those commitments.
    const visibility = value.evidence_visibility ?? "bundled";
    requireValue(
      visibility === "bundled" || visibility === "private-attested",
      "Unknown acceptance evidence visibility.",
    );
    if (visibility === "private-attested") {
      requireValue(
        value.files.every((file) => file.role === "package"),
        "Private acceptance and review reports must not be distributed.",
      );
    } else {
      for (const item of [...value.acceptance.gates, value.acceptance.review]) {
        const file = files.get(item.report_file.toLowerCase());
        requireValue(
          file &&
            file.sha256 === item.report_sha256 &&
            file.role ===
              (item === value.acceptance.review
                ? "review-report"
                : "acceptance-report"),
          "An acceptance report is not bound to a release artifact.",
        );
      }
    }
  } else {
    requireValue(
      value.trust.release_eligible === false &&
        value.acceptance === null &&
        !own(value.trust, "publisher_key_id") &&
        !own(value, "evidence_visibility"),
      "Development packages must remain unsigned and ineligible for release.",
    );
    text(value.source_revision, "development source revision", 80);
  }
  return value;
}

export function verifyRelease(
  directory,
  trustedKeyFile,
  expectedKeyId,
  expectedPlatform = process.platform + "-" + process.arch,
) {
  text(expectedKeyId, "trusted publisher key ID", 160);
  const root = resolve(directory),
    bytes = readRegularFile(join(root, "manifest.json"), 1024 * 1024);
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  requireValue(
    manifest.trust.publisher_key_id === expectedKeyId &&
      manifest.platform === expectedPlatform,
    "Release publisher or platform does not match the configured trust target.",
  );
  const key = createPublicKey(readRegularFile(trustedKeyFile, 65536));
  const signature = readRegularFile(join(root, "manifest.sig"), 1024)
    .toString("utf8")
    .trim();
  requireValue(
    /^[A-Za-z0-9+/]{86}==$/u.test(signature) &&
      key.asymmetricKeyType === "ed25519" &&
      verify(null, bytes, key, Buffer.from(signature, "base64")),
    "Publisher signature verification failed.",
  );
  for (const file of manifest.files) {
    const data = readRegularFile(join(root, file.name));
    requireValue(
      data.length === file.size && sha256(data) === file.sha256,
      "Release artifact mismatch: " + file.name,
    );
  }
  return {
    ok: true,
    platform: manifest.platform,
    runtime_version: manifest.runtime_version,
    source_revision: manifest.source_revision,
    publisher: expectedKeyId,
    package: manifest.files.find((file) => file.role === "package").name,
  };
}

export function npmCommand(args, options = {}) {
  if (process.platform !== "win32")
    return execFileSync("npm", args, { ...options, windowsHide: true });
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);
  const cli = candidates.find((file) => {
    try {
      return file.endsWith("npm-cli.js") && lstatSync(file).isFile();
    } catch {
      return false;
    }
  });
  requireValue(
    cli,
    "Cannot locate npm-cli.js beside Node.js; install Node.js 24 with npm.",
  );
  return execFileSync(process.execPath, [cli, ...args], {
    ...options,
    windowsHide: true,
  });
}
