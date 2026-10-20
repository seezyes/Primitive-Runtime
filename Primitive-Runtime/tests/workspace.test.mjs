import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  createSnapshot,
  readArtifact,
  writeArtifact,
  freezeCandidate,
  assertWorkspaceUnchanged,
  artifactPath,
} from "../dist/runtime/src/workspace/index.js";
import { removeTree } from "../dist/runtime/src/workspace/manifest.js";

const limits = {
  max_file_bytes: 1024 * 1024,
  max_workspace_bytes: 4 * 1024 * 1024,
  max_files: 100,
};
function git(root, args) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Runtime Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
async function fixture(
  t,
  files = { "src/api.txt": "old\n", "tests/check.txt": "check\n" },
) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "primitive-workspace-test-"),
  );
  t.after(() => removeTree(temp));
  const source = path.join(temp, "source");
  await fs.mkdir(source);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), content);
  }
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "fixture"]);
  return {
    source,
    temp,
    snapshot: () => createSnapshot(source, path.join(temp, "stage"), limits),
  };
}

test("staging edits, creation and deletion produce an applicable diff without modifying the source", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  const original = await readArtifact(snapshot.root, "src/api.txt", 1024);
  await writeArtifact(snapshot.root, "src/api.txt", "new\n", original.hash);
  await writeArtifact(
    snapshot.root,
    "src/new file.txt",
    "new component\n",
    null,
  );
  const deleted = await readArtifact(snapshot.root, "tests/check.txt", 1024);
  await writeArtifact(snapshot.root, "tests/check.txt", null, deleted.hash);
  const candidate = await freezeCandidate(
    snapshot,
    path.join(f.temp, "candidate"),
  );
  assert.deepEqual(candidate.files_changed, [
    "src/api.txt",
    "src/new file.txt",
    "tests/check.txt",
  ]);
  assert.match(candidate.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    await fs.readFile(path.join(f.source, "src/api.txt"), "utf8"),
    "old\n",
  );
  assert.equal(git(f.source, ["status", "--porcelain"]), "");
  const patch = path.join(f.temp, "candidate.patch");
  await fs.writeFile(patch, candidate.diff);
  git(f.source, ["apply", "--check", patch]);
  assert.equal((await fs.stat(candidate.root)).mode & 0o222, 0);
  assert.equal(
    (await fs.stat(path.join(candidate.root, "src/api.txt"))).mode & 0o222,
    0,
  );
});

test("dirty and untracked source trees are rejected without stashing or resetting", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "untracked.txt"), "private work");
  await assert.rejects(f.snapshot(), { code: "WORKSPACE_DIRTY" });
  assert.equal(
    await fs.readFile(path.join(f.source, "untracked.txt"), "utf8"),
    "private work",
  );
});

test("external source changes invalidate the baseline and candidate freeze", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  await fs.writeFile(path.join(f.source, "src/api.txt"), "external edit\n");
  await assert.rejects(assertWorkspaceUnchanged(snapshot), {
    code: "WORKSPACE_CONFLICT",
  });
  await assert.rejects(
    freezeCandidate(snapshot, path.join(f.temp, "candidate")),
    { code: "WORKSPACE_CONFLICT" },
  );
  assert.equal(
    await fs.readFile(path.join(f.source, "src/api.txt"), "utf8"),
    "external edit\n",
  );
});

test("traversal, drive paths, reserved names and case aliases cannot acquire artifact identity", async (t) => {
  for (const bad of [
    "../secret",
    "/etc/passwd",
    "a/../b",
    "a//b",
    "C:/secret",
    "a\\b",
    ".git/config",
    "x/.GIT/config",
    "CON",
    "a.",
    "a\nfile",
    "e\u0301.txt",
  ]) {
    assert.throws(
      () => artifactPath(bad),
      { code: "INVALID_ARTIFACT_PATH" },
      bad,
    );
  }
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  await assert.rejects(
    writeArtifact(snapshot.root, "SRC/new.txt", "bad", null),
    { code: "UNSUPPORTED_ARTIFACT" },
  );
  await assert.rejects(
    writeArtifact(snapshot.root, "src/API.txt", "bad", null),
    { code: "UNSUPPORTED_ARTIFACT" },
  );
});

test("symlink parents, owned symlinks and hardlink aliases are denied", async (t) => {
  if (process.platform === "win32")
    return t.skip(
      "Fixture link creation requires platform privileges; Linux gate covers this case.",
    );
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  await fs.symlink(f.source, path.join(snapshot.root, "escape"));
  await assert.rejects(
    readArtifact(snapshot.root, "escape/src/api.txt", 1024),
    { code: "UNSUPPORTED_ARTIFACT" },
  );
  await assert.rejects(
    writeArtifact(snapshot.root, "escape/src/api.txt", "bad", null),
    { code: "UNSUPPORTED_ARTIFACT" },
  );
  await fs.symlink(
    path.join(f.source, "src/api.txt"),
    path.join(snapshot.root, "linked.txt"),
  );
  await assert.rejects(readArtifact(snapshot.root, "linked.txt", 1024), {
    code: "UNSUPPORTED_ARTIFACT",
  });
  await fs.link(
    path.join(snapshot.root, "src/api.txt"),
    path.join(snapshot.root, "hard.txt"),
  );
  await assert.rejects(readArtifact(snapshot.root, "src/api.txt", 1024), {
    code: "UNSUPPORTED_ARTIFACT",
  });
  assert.equal(
    await fs.readFile(path.join(f.source, "src/api.txt"), "utf8"),
    "old\n",
  );
});

test("a cancelled generation fails at the synchronous commit fence without changing bytes", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  const before = await readArtifact(snapshot.root, "src/api.txt", 1024);
  await assert.rejects(
    writeArtifact(snapshot.root, "src/api.txt", "stale\n", before.hash, () => {
      throw Object.assign(new Error("generation fenced"), {
        code: "CANCELLED",
      });
    }),
    { code: "CANCELLED" },
  );
  assert.equal(
    (await readArtifact(snapshot.root, "src/api.txt", 1024)).content,
    "old\n",
  );
  assert.deepEqual((await fs.readdir(path.join(snapshot.root, "src"))).sort(), [
    "api.txt",
  ]);
});

test("concurrent proposals cannot both write from the same expected hash", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.snapshot();
  const before = await readArtifact(snapshot.root, "src/api.txt", 1024);
  const result = await Promise.allSettled([
    writeArtifact(snapshot.root, "src/api.txt", "first\n", before.hash),
    writeArtifact(snapshot.root, "src/api.txt", "second\n", before.hash),
  ]);
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    result.find((item) => item.status === "rejected").reason.code,
    "PATCH_CONFLICT",
  );
});

test("unchanged binary assets are preserved, but binary reads and modifications are rejected", async (t) => {
  const f = await fixture(t, {
    "asset.bin": Buffer.from([0, 1, 255]),
    "readme.txt": "text",
  });
  const snapshot = await f.snapshot();
  await assert.rejects(readArtifact(snapshot.root, "asset.bin", 1024), {
    code: "UNSUPPORTED_ARTIFACT",
  });
  await assert.rejects(
    writeArtifact(
      snapshot.root,
      "readme.txt",
      "\0binary",
      snapshot.manifest["readme.txt"].hash,
    ),
    { code: "UNSUPPORTED_ARTIFACT" },
  );
  const candidate = await freezeCandidate(
    snapshot,
    path.join(f.temp, "candidate"),
  );
  assert.deepEqual(
    await fs.readFile(path.join(candidate.root, "asset.bin")),
    Buffer.from([0, 1, 255]),
  );
  assert.equal(candidate.diff, "");
});

test("persisted manifests handle artifact names that coincide with object prototype keys", async (t) => {
  const f = await fixture(t);
  const snapshot = JSON.parse(JSON.stringify(await f.snapshot()));
  await writeArtifact(snapshot.root, "constructor", "artifact\n", null);
  await writeArtifact(snapshot.root, "__proto__", "another artifact\n", null);
  const candidate = await freezeCandidate(
    snapshot,
    path.join(f.temp, "candidate"),
  );
  assert.deepEqual(candidate.files_changed, ["__proto__", "constructor"]);
});

test("assume-unchanged index flags do not hide edits from admission", async (t) => {
  const f = await fixture(t);
  git(f.source, ["update-index", "--assume-unchanged", "src/api.txt"]);
  await fs.writeFile(path.join(f.source, "src/api.txt"), "hidden dirty work\n");
  await assert.rejects(f.snapshot(), { code: "WORKSPACE_DIRTY" });
});
