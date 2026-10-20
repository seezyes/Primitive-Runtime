import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createOperatorConfig } from "../dist/runtime/src/control/config.js";
import { acquireStateLock } from "../dist/runtime/src/control/state-lock.js";
import { Configuration } from "../dist/runtime/src/control/config.js";
import { inspectEngine } from "../dist/runtime/src/engine/version.js";
import { atomicJSON } from "../dist/runtime/src/util.js";
import {
  assertReleaseReady,
  loadAcceptance,
  npmCommand,
  REQUIRED_GATES,
  sha256,
  UPSTREAM_COMMIT,
  validateManifest,
  verifyRelease,
} from "../scripts/lib/release.mjs";
import {
  dedicatedStatePath,
  inspectStateOwnership,
  uninstallRuntime,
} from "../scripts/lib/state.mjs";
import { packageRelease } from "../scripts/package-release.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVISION = "a".repeat(40);
const PLATFORM = process.platform + "-" + process.arch;
const MARKER = ".primitive-runtime-state.json";

function temporary(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "primitive-release-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function evidenceFixture(directory) {
  // Synthetic fixture evidence tests the release protocol; it is never
  // published or represented as an actual product/platform acceptance result.
  const report = Buffer.from(
    "SYNTHETIC TEST FIXTURE: no platform acceptance claim.\n",
  );
  const review = Buffer.from(
    "SYNTHETIC REVIEW FIXTURE: signature/schema test only.\n",
  );
  fs.writeFileSync(path.join(directory, "suite.txt"), report);
  fs.writeFileSync(path.join(directory, "review.txt"), review);
  const expected = {
    source_revision: REVISION,
    runtime_version: "0.1.0",
    contract_version: "primitive-runtime/0.1",
    platform: PLATFORM,
    engine_sha256: sha256("fixture engine"),
  };
  const evidence = {
    evidence_version: 1,
    ...expected,
    node_major: 24,
    recorded_at: "2026-10-20T00:00:00.000Z",
    isolation_backend: process.platform === "win32" ? "docker" : "bwrap",
    gates: REQUIRED_GATES.map((id) => ({
      id,
      status: "passed",
      report_file: "suite.txt",
      report_sha256: sha256(report),
    })),
    review: {
      status: "approved",
      reviewer: "test-fixture",
      source_revision: REVISION,
      reviewed_at: "2026-10-20T00:00:00.000Z",
      report_file: "review.txt",
      report_sha256: sha256(review),
    },
  };
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, JSON.stringify(evidence));
  return { file, evidence, expected };
}

function nativeFixture() {
  return {
    name: "jcode-primitive",
    version: "0.1.0",
    source_revision: REVISION,
    engine_protocol: "primitive-engine/1",
    policy_revision: "primitive-policy/1",
    upstream_commit: UPSTREAM_COMMIT,
    turn_core_protocol: "jcode-turn/1",
    shared_ordinary_turn_core: true,
    restricted_mode: true,
    ordinary_tools: false,
    ambient_credentials: false,
    sha256: sha256("fixture engine"),
  };
}

function manifestFixture(directory) {
  const fixture = evidenceFixture(directory),
    accepted = loadAcceptance(fixture.file, fixture.expected);
  const archive = Buffer.from(
    "SYNTHETIC ARCHIVE BYTES FOR MANIFEST INTEGRITY TEST",
  );
  const packageName = "primitive-runtime-fixture.tgz";
  fs.writeFileSync(path.join(directory, packageName), archive);
  for (const file of accepted.files)
    fs.writeFileSync(path.join(directory, file.name), file.bytes);
  const manifest = {
    manifest_version: 1,
    runtime_version: "0.1.0",
    contract_version: "primitive-runtime/0.1",
    mcp_versions: ["2025-06-18"],
    platform: PLATFORM,
    source_revision: REVISION,
    engine: nativeFixture(),
    files: [
      {
        name: packageName,
        role: "package",
        sha256: sha256(archive),
        size: archive.length,
      },
      ...accepted.files.map(({ bytes, ...file }) => file),
    ],
    acceptance: accepted.evidence,
    trust: {
      kind: "ed25519",
      release_eligible: true,
      publisher_key_id: "ephemeral-test-publisher",
    },
  };
  return { manifest, packageName };
}

function stateFixture(directory) {
  const binary = path.join(directory, "fixture-engine");
  fs.writeFileSync(binary, "configuration hash fixture");
  const state = path.join(directory, "state");
  createOperatorConfig(state, binary);
  return state;
}

test("a signing key cannot replace exact clean source, native provenance, or reviewed evidence", () => {
  assert.throws(
    () =>
      assertReleaseReady(
        { clean: false, revision: REVISION },
        nativeFixture(),
        {},
      ),
    /clean Git/,
  );
  assert.throws(
    () =>
      assertReleaseReady(
        { clean: true, revision: "uncommitted-source" },
        nativeFixture(),
        {},
      ),
    /exact/,
  );
  assert.throws(
    () =>
      assertReleaseReady(
        { clean: true, revision: REVISION },
        { ...nativeFixture(), source_revision: "unreleased-source" },
        {},
      ),
    /same reviewed/,
  );
  assert.throws(
    () =>
      assertReleaseReady(
        { clean: true, revision: REVISION },
        nativeFixture(),
        null,
      ),
    /explicit reviewed/,
  );
});

test("release evidence rejects skipped gates, another binary/platform, changed reports and missing review", (t) => {
  const directory = temporary(t),
    fixture = evidenceFixture(directory);
  assert.equal(
    loadAcceptance(fixture.file, fixture.expected).evidence.gates.length,
    REQUIRED_GATES.length,
  );
  for (const mutate of [
    (value) => {
      value.gates[0].status = "skipped";
    },
    (value) => {
      value.gates.pop();
    },
    (value) => {
      value.gates[1].id = value.gates[0].id;
    },
    (value) => {
      value.review.status = "pending";
    },
    (value) => {
      value.review.source_revision = "b".repeat(40);
    },
    (value) => {
      value.platform = PLATFORM === "linux-x64" ? "win32-x64" : "linux-x64";
    },
    (value) => {
      value.engine_sha256 = sha256("different engine");
    },
    (value) => {
      value.gates[0].report_file = "../outside.txt";
    },
  ]) {
    const value = structuredClone(fixture.evidence);
    mutate(value);
    fs.writeFileSync(fixture.file, JSON.stringify(value));
    assert.throws(() => loadAcceptance(fixture.file, fixture.expected));
  }
  fs.writeFileSync(fixture.file, JSON.stringify(fixture.evidence));
  fs.appendFileSync(path.join(directory, "suite.txt"), "mutated");
  assert.throws(() => loadAcceptance(fixture.file, fixture.expected), /hash/);
});

test("strict manifest rejects empty artifacts, incomplete identity, unsafe paths and unbound evidence", (t) => {
  const { manifest } = manifestFixture(temporary(t));
  assert.equal(validateManifest(manifest).platform, PLATFORM);
  assert.throws(
    () => validateManifest({ trust: manifest.trust, files: [] }),
    /missing/,
  );
  for (const mutate of [
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files[0].name = "../outside.tgz";
    },
    (value) => {
      value.files[0].name = "C:\\outside.tgz";
    },
    (value) => {
      value.files.push({ ...value.files[0] });
    },
    (value) => {
      value.source_revision = "uncommitted-source";
    },
    (value) => {
      value.engine.source_revision = "unreleased-source";
    },
    (value) => {
      delete value.engine.turn_core_protocol;
    },
    (value) => {
      value.engine.shared_ordinary_turn_core = false;
    },
    (value) => {
      value.acceptance.gates[0].report_sha256 = sha256("different");
    },
    (value) => {
      value.trust.release_eligible = false;
    },
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    assert.throws(() => validateManifest(value));
  }
});

test("verification binds publisher identity, platform, signature, and every report/package byte", (t) => {
  const directory = temporary(t),
    { manifest, packageName } = manifestFixture(directory);
  const key = generateKeyPairSync("ed25519"),
    keyFile = path.join(directory, "trusted.pem");
  fs.writeFileSync(
    keyFile,
    key.publicKey.export({ type: "spki", format: "pem" }),
  );
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "manifest.json"), bytes);
  fs.writeFileSync(
    path.join(directory, "manifest.sig"),
    sign(null, bytes, key.privateKey).toString("base64"),
  );
  assert.equal(
    verifyRelease(directory, keyFile, "ephemeral-test-publisher").ok,
    true,
  );
  assert.throws(
    () => verifyRelease(directory, keyFile, "untrusted-publisher"),
    /trust target/,
  );
  assert.throws(
    () =>
      verifyRelease(
        directory,
        keyFile,
        "ephemeral-test-publisher",
        "unadvertised-platform",
      ),
    /trust target/,
  );
  fs.writeFileSync(
    keyFile,
    generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }),
  );
  assert.throws(
    () => verifyRelease(directory, keyFile, "ephemeral-test-publisher"),
    /signature/,
  );
  fs.writeFileSync(
    keyFile,
    key.publicKey.export({ type: "spki", format: "pem" }),
  );
  fs.appendFileSync(path.join(directory, packageName), "tampered");
  assert.throws(
    () => verifyRelease(directory, keyFile, "ephemeral-test-publisher"),
    /artifact mismatch/,
  );
});

test("initialization cannot adopt an existing source directory and uninstall requires its marker", async (t) => {
  const directory = temporary(t),
    binary = path.join(directory, "engine");
  fs.writeFileSync(binary, "fixture");
  const existing = path.join(directory, "source");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "source.txt"), "preserve");
  assert.throws(
    () => createOperatorConfig(existing, binary),
    /empty dedicated/,
  );
  assert.equal(
    fs.readFileSync(path.join(existing, "source.txt"), "utf8"),
    "preserve",
  );
  const state = stateFixture(directory);
  fs.unlinkSync(path.join(state, MARKER));
  await assert.rejects(uninstallRuntime(state));
  assert.equal(fs.existsSync(path.join(state, "operator.json")), true);
});

test("uninstall preserves unknown files and rejects workspace overlap and path aliases", async (t) => {
  const directory = temporary(t),
    state = stateFixture(directory);
  fs.writeFileSync(path.join(state, "unowned-source.txt"), "preserve");
  await assert.rejects(uninstallRuntime(state), /Unrecognized state entry/);
  assert.equal(
    fs.readFileSync(path.join(state, "unowned-source.txt"), "utf8"),
    "preserve",
  );
  fs.unlinkSync(path.join(state, "unowned-source.txt"));
  const config = JSON.parse(
    fs.readFileSync(path.join(state, "operator.json"), "utf8"),
  );
  config.workspaces.overlap = { revision: "fixture", path: directory };
  atomicJSON(path.join(state, "operator.json"), config);
  await assert.rejects(
    uninstallRuntime(state),
    /overlaps a configured workspace/,
  );
  config.workspaces.overlap.path = path.parse(state).root;
  atomicJSON(path.join(state, "operator.json"), config);
  await assert.rejects(
    uninstallRuntime(state),
    /overlaps a configured workspace/,
  );
  const alias = path.join(directory, "alias");
  fs.symlinkSync(
    state,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => dedicatedStatePath(alias), /symlinks or junctions/);
});

test("a live service/maintenance ownership lock prevents uninstall", async (t) => {
  const state = stateFixture(temporary(t)),
    release = acquireStateLock(state);
  try {
    await assert.rejects(
      uninstallRuntime(state),
      (error) => error.code === "SERVICE_RUNNING",
    );
  } finally {
    release();
  }
  assert.equal(
    inspectStateOwnership(state).marker.product,
    "primitive-runtime",
  );
});

test("uncleared doctor leases survive uninstall and durably fence further admission", async (t) => {
  const state = stateFixture(temporary(t)),
    leases = path.join(state, "doctor-leases");
  fs.mkdirSync(leases);
  fs.writeFileSync(path.join(leases, "unacknowledged.json"), "{}");
  await assert.rejects(uninstallRuntime(state));
  assert.equal(fs.existsSync(path.join(leases, "unacknowledged.json")), true);
  assert.equal(fs.existsSync(path.join(state, "operator.json")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state, MARKER), "utf8")).state,
    "deleting",
  );
  assert.throws(() => acquireStateLock(state));
});

test("uninstall removes readonly snapshots after cleanup while preserving external source", async (t) => {
  const directory = temporary(t),
    state = stateFixture(directory),
    source = path.join(directory, "source.txt");
  fs.writeFileSync(source, "external source");
  const snapshot = path.join(
    state,
    "runs",
    "pr_run_" + "d".repeat(24),
    "candidate-0",
    "nested",
  );
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "code.txt"), "candidate");
  fs.chmodSync(path.join(snapshot, "code.txt"), 0o444);
  fs.chmodSync(snapshot, 0o555);
  fs.chmodSync(path.dirname(snapshot), 0o555);
  const result = await uninstallRuntime(state);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.readFileSync(source, "utf8"), "external source");
});

test("a deleting marker supports cleanup retry after configuration removal without reopening admission", async (t) => {
  const state = stateFixture(temporary(t));
  const marker = JSON.parse(fs.readFileSync(path.join(state, MARKER), "utf8"));
  atomicJSON(path.join(state, MARKER), { ...marker, state: "deleting" });
  fs.unlinkSync(path.join(state, "operator.json"));
  fs.unlinkSync(path.join(state, "operator-client.json"));
  assert.throws(() => acquireStateLock(state));
  assert.equal((await uninstallRuntime(state)).removed, true);
});

test("operator example is schema-valid, inert until initialization, and uses supported credential references", async (t) => {
  const directory = temporary(t),
    example = JSON.parse(
      fs.readFileSync(path.join(ROOT, "config/operator.example.json"), "utf8"),
    );
  const file = path.join(directory, "operator-example.json");
  fs.writeFileSync(file, JSON.stringify(example), { mode: 0o600 });
  const config = new Configuration(file).current;
  assert.equal(config.engine.sha256, "sha256:" + "0".repeat(64));
  assert.equal(config.operator_token_hash, "sha256:" + "0".repeat(64));
  assert.equal(
    Object.values(config.endpoints)[0].credential_ref,
    "env:PRIMITIVE_MODEL_API_KEY",
  );
  assert.equal(
    Object.values(config.validation_profiles)[0].checks.some(
      (check) => check.required,
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(directory, MARKER)),
    false,
    "Reading an example must not initialize runtime state.",
  );
  const binary = path.join(directory, "not-an-engine");
  fs.writeFileSync(binary, "an inert placeholder that must never execute");
  const inspection = await inspectEngine({ ...config.engine, binary });
  assert.equal(inspection.available, false);
  assert.equal(inspection.hash_matches, false);
  assert.match(inspection.error, /hash/);
  const invalid = structuredClone(example);
  Object.values(invalid.endpoints)[0].credential_ref =
    "secret:legacy-unsupported";
  fs.writeFileSync(file, JSON.stringify(invalid));
  assert.throws(() => new Configuration(file));
});

test(
  "unsigned product package installs independently, diagnoses missing configuration, and uninstalls",
  { timeout: 120000 },
  async (t) => {
    const directory = temporary(t),
      output = path.join(directory, "release");
    const packaged = packageRelease({
      ...process.env,
      PRIMITIVE_RELEASE_DIRECTORY: output,
      PRIMITIVE_RELEASE_SIGNING_KEY: undefined,
      PRIMITIVE_RELEASE_KEY_ID: undefined,
      PRIMITIVE_RELEASE_ACCEPTANCE: undefined,
    });
    assert.equal(packaged.release_eligible, false);
    assert.equal(packaged.signed, false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
    );
    assert.equal(validateManifest(manifest, false).acceptance, null);
    assert.throws(() => validateManifest(manifest), /unsigned/);
    assert.equal(fs.existsSync(path.join(output, "manifest.sig")), false);
    const prefix = path.join(directory, "installed");
    npmCommand(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        path.join(output, packaged.package),
      ],
      { encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
    );
    const installed = path.join(prefix, "node_modules", "primitive-runtime");
    assert.equal(fs.existsSync(path.join(installed, "tests")), false);
    assert.equal(
      fs.readFileSync(path.join(installed, "README.md"), "utf8"),
      fs.readFileSync(path.join(ROOT, "README.md"), "utf8"),
    );
    assert.equal(
      fs.readFileSync(
        path.join(installed, "packages/operator-tui/NOTICE.md"),
        "utf8",
      ),
      fs.readFileSync(
        path.join(ROOT, "packages/operator-tui/NOTICE.md"),
        "utf8",
      ),
    );
    assert.equal(
      fs.existsSync(path.join(installed, "licenses/Primitive-Runtime-LICENSE")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(installed, "licenses/JCode-LICENSE")),
      true,
    );
    assert.deepEqual(fs.readdirSync(path.join(installed, "bin")), [PLATFORM]);
    assert.equal(
      fs.existsSync(path.join(installed, "engine/jcode")),
      false,
      "No Rust source checkout is needed by the installer.",
    );
    const state = path.join(directory, "installed-state");
    const run = (args) =>
      spawnSync(process.execPath, args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 20000,
      });
    const refusal = run([path.join(installed, "scripts/install.mjs"), state]);
    assert.equal(refusal.status, 1);
    assert.match(refusal.stderr, /allow-unsigned-development/);
    assert.equal(fs.existsSync(state), false);
    const init = run([
      path.join(installed, "scripts/install.mjs"),
      state,
      "--allow-unsigned-development",
    ]);
    assert.equal(init.status, 0, init.stderr);
    const locations = JSON.parse(init.stdout);
    const version = run([
      path.join(installed, "dist/runtime/src/cli.js"),
      "version",
      "--json",
    ]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(
      JSON.parse(version.stdout).source_revision,
      manifest.source_revision,
    );
    const diagnostic = run([
      path.join(installed, "dist/runtime/src/cli.js"),
      "doctor",
      "--config",
      locations.config_file,
      "--json",
    ]);
    assert.equal(diagnostic.status, 1, diagnostic.stderr);
    const report = JSON.parse(diagnostic.stdout);
    assert.equal(report.engine.hash_matches, true);
    assert.equal(report.engine.available, true);
    assert.equal(
      report.ready,
      false,
      "An empty installation must not claim configured model/sandbox readiness.",
    );
    const removed = run([
      path.join(installed, "scripts/uninstall.mjs"),
      state,
      "--delete-runtime-state",
    ]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(state), false);
  },
);
