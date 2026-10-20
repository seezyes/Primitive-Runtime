import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  probeSandbox,
  recoverValidationLeases,
  validateCandidate,
} from "../dist/runtime/src/validation/index.js";
import {
  createDockerLease,
  markDockerCreated,
} from "../dist/runtime/src/validation/leases.js";
import {
  hashManifest,
  scanManifest,
  removeTree,
} from "../dist/runtime/src/workspace/manifest.js";

const base = {
  id: "fixture",
  revision: "checks-v1",
  backend: "bwrap",
  network: "none",
  checks: [
    {
      id: "unit",
      command: "/usr/bin/python3",
      args: ["-c", 'print("passed")'],
      required: true,
      timeout_seconds: 5,
    },
  ],
  limits: {
    memory_mb: 256,
    cpu_seconds: 5,
    pids: 32,
    max_output_bytes: 4096,
    max_disk_mb: 8,
  },
};
async function candidate(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "primitive-validation-test-"),
  );
  t.after(() => removeTree(root));
  await fs.writeFile(path.join(root, "source.txt"), "immutable candidate\n");
  return {
    root,
    hash: hashManifest(
      await scanManifest(root, {
        max_file_bytes: 4096,
        max_workspace_bytes: 4096,
        max_files: 10,
      }),
    ),
  };
}
let detected;
async function requireSandbox(t) {
  detected ??= await probeSandbox(base);
  if (!detected.available) {
    t.skip(`Real sandbox unavailable in this environment: ${detected.reason}`);
    return false;
  }
  return true;
}
function python(code, overrides = {}) {
  return {
    ...structuredClone(base),
    ...overrides,
    checks: [{ ...base.checks[0], args: ["-c", code] }],
  };
}

test("missing mandatory checks are unverified and cannot be promoted to passing", async (t) => {
  const c = await candidate(t);
  const report = await validateCandidate(c.root, c.hash, {
    ...base,
    checks: [],
  });
  assert.equal(report.verification, "unverified");
  assert.equal(report.infrastructure_error.code, "VALIDATION_UNAVAILABLE");
});

test("network-enabled and unpinned Docker profiles fail closed", async () => {
  assert.equal(
    (await probeSandbox({ ...base, network: "host" })).available,
    false,
  );
  const docker = await probeSandbox({
    ...base,
    backend: "docker",
    image: "python:latest",
  });
  assert.equal(docker.available, false);
  assert.match(docker.reason, /digest/);
});

test("candidate identity mismatches cannot reach validation", async (t) => {
  const c = await candidate(t);
  const report = await validateCandidate(c.root, "sha256:wrong", base);
  assert.equal(report.verification, "unverified");
  assert.equal(report.infrastructure_error.code, "PATCH_CONFLICT");
});

test("real sandbox isolates credentials, host paths, networking, mounts, and the frozen candidate", async (t) => {
  if (!(await requireSandbox(t))) return;
  const c = await candidate(t);
  const secret = `secret-${Date.now()}`;
  process.env.PRIMITIVE_TEST_CREDENTIAL = secret;
  t.after(() => {
    delete process.env.PRIMITIVE_TEST_CREDENTIAL;
  });
  const report = await validateCandidate(
    c.root,
    c.hash,
    python(`
import os, pathlib, socket, ctypes, errno
assert os.getcwd() == '/workspace'
assert 'PRIMITIVE_TEST_CREDENTIAL' not in os.environ
assert not pathlib.Path('/etc/shadow').exists()
assert not pathlib.Path('/root').exists()
assert list(pathlib.Path('/proc').iterdir()) == []
assert pathlib.Path('/candidate/source.txt').read_text() == 'immutable candidate\\n'
pathlib.Path('/workspace/source.txt').write_text('temporary test output')
for p in ['/candidate/source.txt', '/not-allowed', '/dev/not-allowed']:
 try: pathlib.Path(p).write_text('escape'); raise AssertionError('write escaped sandbox')
 except OSError: pass
s=socket.socket();s.settimeout(.1)
try: s.connect(('127.0.0.1', 1)); raise AssertionError('network unexpectedly reachable')
except OSError: pass
finally: s.close()
libc=ctypes.CDLL(None,use_errno=True)
assert libc.syscall(272, 0x10000000) == -1 and ctypes.get_errno() == errno.EPERM
print('isolated')
`),
  );
  assert.equal(report.verification, "passed", JSON.stringify(report));
  assert.equal(report.sandbox.proc, false);
  assert.equal(report.checks[0].candidate_hash, c.hash);
  assert.equal(
    await fs.readFile(path.join(c.root, "source.txt"), "utf8"),
    "immutable candidate\n",
  );
  assert.doesNotMatch(report.checks[0].output, new RegExp(secret));
});

test("failing commands remain failed, while a missing executable is infrastructure-unverified", async (t) => {
  if (!(await requireSandbox(t))) return;
  const c = await candidate(t);
  const failed = await validateCandidate(
    c.root,
    c.hash,
    python("raise SystemExit(7)"),
  );
  assert.equal(failed.verification, "failed");
  assert.equal(failed.checks[0].exit_code, 7);
  const unavailable = await validateCandidate(c.root, c.hash, {
    ...base,
    checks: [{ ...base.checks[0], command: "/missing/check" }],
  });
  assert.equal(unavailable.verification, "unverified");
  assert.equal(unavailable.infrastructure_error.code, "VALIDATION_UNAVAILABLE");
});

test("real process and disk limits prevent fork and scratch-space exhaustion", async (t) => {
  if (!(await requireSandbox(t))) return;
  const c = await candidate(t);
  const profile = python(
    `
import subprocess, pathlib, errno
children=[]
try:
 try:
  for i in range(40): children.append(subprocess.Popen(['/bin/sleep','5']))
  raise AssertionError('process limit not enforced')
 except OSError as error: assert error.errno == errno.EAGAIN
finally:
 for child in children: child.kill()
 for child in children: child.wait()
try:
 with open('/tmp/fill','wb') as f:
  for i in range(32): f.write(b'x'*1024*1024)
 raise AssertionError('disk limit not enforced')
except OSError as error: assert error.errno in [errno.ENOSPC,errno.EFBIG]
print('bounded')
`,
    { limits: { ...base.limits, pids: 12 } },
  );
  const report = await validateCandidate(c.root, c.hash, profile);
  assert.equal(report.verification, "passed", JSON.stringify(report));
});

test("timeout kills the validation process tree and output is bounded", async (t) => {
  if (!(await requireSandbox(t))) return;
  const c = await candidate(t);
  const timeout = python(
    'import subprocess; subprocess.Popen(["/bin/sleep","60"]); import time; time.sleep(60)',
  );
  timeout.checks[0].timeout_seconds = 1;
  const report = await validateCandidate(c.root, c.hash, timeout);
  assert.equal(report.verification, "failed");
  assert.equal(report.checks[0].timed_out, true);
  const noisy = python('print("x"*10000)', {
    limits: { ...base.limits, max_output_bytes: 128 },
  });
  const output = await validateCandidate(c.root, c.hash, noisy);
  assert.equal(output.verification, "failed");
  assert.equal(output.checks[0].output_truncated, true);
  assert.ok(Buffer.byteLength(output.checks[0].output) <= 128);
});

test("cancellation rejects only after isolated processes acknowledge cleanup", async (t) => {
  if (!(await requireSandbox(t))) return;
  const c = await candidate(t);
  const controller = new AbortController();
  const operation = validateCandidate(
    c.root,
    c.hash,
    python("import time; time.sleep(60)"),
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(
      operation,
      (error) => error.code === "CANCELLED" || error.name === "AbortError",
    );
  } finally {
    clearTimeout(timer);
  }
});

test("service SIGKILL kills the bubblewrap namespace and its long-lived descendants", async (t) => {
  if (!(await requireSandbox(t))) return;
  if (process.platform !== "linux") return t.skip("Linux process-death gate.");
  const c = await candidate(t);
  const moduleURL = new URL(
    "../dist/runtime/src/validation/index.js",
    import.meta.url,
  ).href;
  const profile = {
    ...base,
    checks: [
      {
        ...base.checks[0],
        command: "/bin/sh",
        args: ["-c", "sleep 60 & wait"],
        timeout_seconds: 20,
      },
    ],
  };
  const code = `import {validateCandidate} from ${JSON.stringify(moduleURL)}; process.stdout.write(JSON.stringify(await validateCandidate(${JSON.stringify(c.root)},${JSON.stringify(c.hash)},${JSON.stringify(profile)})));`;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  worker.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  t.after(() => worker.kill("SIGKILL"));
  const closed = new Promise((resolve) => worker.on("close", resolve));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function descendants(pid) {
    // /proc/<pid>/task/<pid>/children requires CONFIG_CHECKPOINT_RESTORE,
    // which is absent in some otherwise usable namespace environments.
    const pairs = [];
    for (const name of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = await fs.readFile(`/proc/${name}/stat`, "utf8");
        const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        pairs.push([Number(name), Number(afterName[1])]);
      } catch {
        /* process exited during the snapshot */
      }
    }
    const nested = [];
    const queue = [pid];
    while (queue.length) {
      const parent = queue.shift();
      for (const [child, actualParent] of pairs)
        if (actualParent === parent && !nested.includes(child)) {
          nested.push(child);
          queue.push(child);
        }
    }
    return nested;
  }
  let processes = [];
  for (let i = 0; i < 80; i++) {
    processes = await descendants(worker.pid);
    const names = await Promise.all(
      processes.map((pid) =>
        fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => ""),
      ),
    );
    if (names.some((name) => name.trim() === "sleep")) break;
    await sleep(50);
  }
  assert.ok(
    processes.length >= 3,
    `The sandbox must be running before the simulated service crash: ${diagnostics}`,
  );
  worker.kill("SIGKILL");
  await closed;
  let live = [];
  for (let i = 0; i < 40; i++) {
    live = [];
    for (const pid of processes) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        if (!/\) Z /u.test(stat)) live.push(pid);
      } catch {
        /* already reaped */
      }
    }
    if (!live.length) break;
    await sleep(50);
  }
  assert.deepEqual(
    live,
    [],
    "No validation descendant may keep executing after the service dies.",
  );
});

test("Docker requires persistent receipts; indeterminate creation and identity mismatches fail closed", async (t) => {
  const digest = `example.invalid/runtime@sha256:${"a".repeat(64)}`;
  const noLease = await probeSandbox({
    ...base,
    backend: "docker",
    image: digest,
  });
  assert.equal(noLease.available, false);
  assert.match(noLease.reason, /lease directory/);
  if (process.platform === "win32")
    return t.skip("The recovery CLI fixture uses a Unix executable script.");
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "primitive-lease-test-"),
  );
  t.after(() => removeTree(temp));
  const executable = path.join(temp, "docker");
  // The fake daemon tests receipt handling only; it is never used as isolation evidence.
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='inspect'){console.error('Error: No such container');process.exit(1)};console.error('Unexpected mutation');process.exit(2);\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${temp}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const directory = path.join(temp, "leases");
  const lease = await createDockerLease(directory);
  await assert.rejects(recoverValidationLeases(directory), {
    code: "CLEANUP_FAILED",
  });
  assert.equal(
    (await fs.stat(lease.file)).isFile(),
    true,
    "Unknown create receipt must survive recovery.",
  );
  await markDockerCreated(lease, "b".repeat(64));
  assert.deepEqual((await recoverValidationLeases(directory)).recovered, [
    lease.name,
  ]);
  await assert.rejects(fs.stat(lease.file), { code: "ENOENT" });
  const second = await createDockerLease(directory);
  await markDockerCreated(second, "c".repeat(64));
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='inspect'){console.log(JSON.stringify({Id:'${"c".repeat(64)}',Config:{Labels:{'org.primitive-runtime.validation-lease':'someone-else'}}}));process.exit(0)};console.error('Unexpected mutation');process.exit(2);\n`,
    { mode: 0o755 },
  );
  await assert.rejects(recoverValidationLeases(directory), {
    code: "CLEANUP_FAILED",
  });
  assert.equal((await fs.stat(second.file)).isFile(), true);
});
