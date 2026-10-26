#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertReleaseReady,
  inspectNative,
  loadAcceptance,
  npmCommand,
  readJSON,
  readRegularFile,
  RELEASE_PLATFORMS,
  requireValue,
  sha256,
  sourceState,
  validateManifest,
} from "./lib/release.mjs";
import { RELEASE_INVENTORY, allowedReleaseFile } from "./lib/publication.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function copyTree(from, to, accept = () => true) {
  const stat = lstatSync(from);
  requireValue(
    !stat.isSymbolicLink(),
    "Release contents must not contain symlinks: " + from,
  );
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort())
      copyTree(join(from, name), join(to, name), accept);
  } else {
    if (!accept(from)) return;
    requireValue(
      stat.isFile() && stat.nlink === 1,
      "Release contents must be regular files: " + from,
    );
    mkdirSync(resolve(to, ".."), { recursive: true });
    writeFileSync(to, readRegularFile(from), {
      flag: "wx",
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
    });
  }
}

/** Packaging is separate from eligibility: unsigned builds are review artifacts. */
export function packageRelease(environment = process.env) {
  const platform = process.platform + "-" + process.arch;
  requireValue(
    RELEASE_PLATFORMS.includes(platform),
    "No release target is defined for " + platform,
  );
  requireValue(
    Number(process.versions.node.split(".")[0]) === 24,
    "Build this release using Node.js 24.",
  );
  const executable =
    process.platform === "win32" ? "jcode-primitive.exe" : "jcode-primitive";
  const binary = resolve(
    environment.PRIMITIVE_RELEASE_ENGINE ??
      join(root, "engine/jcode/modified/primitive/target/release", executable),
  );
  const native = inspectNative(binary),
    source = sourceState(root),
    pkg = readJSON(join(root, "package.json"));
  requireValue(
    pkg.name === "primitive-runtime",
    "Unexpected npm package identity.",
  );
  const signingKeyFile = environment.PRIMITIVE_RELEASE_SIGNING_KEY;
  const signed = Boolean(signingKeyFile);
  let key, supplied;
  if (signed) {
    assertReleaseReady(
      source,
      native,
      environment.PRIMITIVE_RELEASE_ACCEPTANCE,
    );
    requireValue(
      typeof environment.PRIMITIVE_RELEASE_KEY_ID === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(
          environment.PRIMITIVE_RELEASE_KEY_ID,
        ),
      "Provide an explicit trusted publisher key ID.",
    );
    key = createPrivateKey(readRegularFile(resolve(signingKeyFile), 65536));
    requireValue(
      key.asymmetricKeyType === "ed25519",
      "An Ed25519 publisher signing key is required.",
    );
    supplied = loadAcceptance(
      resolve(environment.PRIMITIVE_RELEASE_ACCEPTANCE),
      {
        source_revision: source.revision,
        platform,
        runtime_version: pkg.version,
        contract_version: "primitive-runtime/0.1",
        engine_sha256: native.sha256,
      },
    );
  } else {
    requireValue(
      !environment.PRIMITIVE_RELEASE_KEY_ID &&
        !environment.PRIMITIVE_RELEASE_ACCEPTANCE,
      "Acceptance evidence and a publisher key ID require an explicit signing key; development packages stay unsigned.",
    );
  }
  const output = resolve(
    environment.PRIMITIVE_RELEASE_DIRECTORY ?? join(root, "release", platform),
  );
  requireValue(
    !existsSync(output) || readdirSync(output).length === 0,
    "Use an empty release output directory to avoid mixing manifests or platform artifacts.",
  );
  const trust = signed
    ? {
        kind: "ed25519",
        release_eligible: true,
        publisher_key_id: environment.PRIMITIVE_RELEASE_KEY_ID,
      }
    : { kind: "unsigned-development", release_eligible: false };
  const build = {
    build_info_version: 1,
    runtime_version: pkg.version,
    contract_version: "primitive-runtime/0.1",
    mcp_versions: ["2025-06-18"],
    platform,
    source_revision: source.source_revision,
    engine: native,
    trust,
    acceptance: supplied?.evidence ?? null,
  };

  // Emit this before npm pack so the installed CLI reports the same provenance.
  writeFileSync(
    join(root, "build-info.json"),
    JSON.stringify(build, null, 2) + "\n",
  );
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc")],
    { cwd: root, stdio: "inherit", timeout: 120000 },
  );
  const advertised = JSON.parse(
    execFileSync(
      process.execPath,
      [join(root, "dist/runtime/src/cli.js"), "version", "--json"],
      { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
    ),
  );
  requireValue(
    advertised.runtime_version === build.runtime_version &&
      advertised.contract_version === build.contract_version &&
      JSON.stringify(advertised.mcp_versions) ===
        JSON.stringify(build.mcp_versions) &&
      advertised.source_revision === build.source_revision &&
      advertised.modified_engine_revision === native.source_revision,
    "Built CLI version does not agree with the release manifest.",
  );
  mkdirSync(join(root, "bin", platform), { recursive: true });
  copyFileSync(binary, join(root, "bin", platform, executable));
  chmodSync(join(root, "bin", platform, executable), 0o755);
  mkdirSync(join(root, "licenses"), { recursive: true });
  copyFileSync(
    join(root, "..", "LICENSE"),
    join(root, "licenses/Primitive-Runtime-LICENSE"),
  );
  copyFileSync(
    join(root, "engine/jcode/modified/LICENSE"),
    join(root, "licenses/JCode-LICENSE"),
  );
  copyFileSync(
    join(root, "package-lock.json"),
    join(root, "npm-shrinkwrap.json"),
  );

  const staging = mkdtempSync(join(tmpdir(), "primitive-package-"));
  try {
    copyTree(join(root, "README.public.md"), join(staging, "README.md"));
    for (const name of RELEASE_INVENTORY) {
      if (name === "dist") copyTree(join(root, name), join(staging, name), file => file.endsWith(".js"));
      else copyTree(join(root, name), join(staging, name));
    }
    // The platform executable is a required runtime artifact.
    copyTree(join(root, "bin", platform), join(staging, "bin", platform));
    const {
      devDependencies: _developmentDependencies,
      scripts: _developmentScripts,
      ...published
    } = pkg;
    published.scripts = { start: "node dist/runtime/src/cli.js" };
    writeFileSync(
      join(staging, "package.json"),
      JSON.stringify(published, null, 2) + "\n",
    );
    mkdirSync(output, { recursive: true });
    const packs = JSON.parse(
      npmCommand(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
        {
          cwd: staging,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    );
    requireValue(
      Array.isArray(packs) && packs.length === 1,
      "npm did not produce exactly one package.",
    );
    const pack = packs[0];
    requireValue(
      Array.isArray(pack.files) && pack.files.length > 0 &&
      pack.files.every(file => allowedReleaseFile(file.path, platform, executable)),
      "Non-product files escaped the release inventory.",
    );
    const required = [
      "README.md",
      "packages/operator-tui/NOTICE.md",
      "licenses/Primitive-Runtime-LICENSE",
      "licenses/JCode-LICENSE",
      "dist/runtime/src/cli.js",
      "build-info.json",
      "scripts/install.mjs",
      "scripts/uninstall.mjs",
      "bin/" + platform + "/" + executable,
    ];
    requireValue(
      required.every((name) => pack.files.some((file) => file.path === name)),
      "npm package is missing a required product file.",
    );
    const bytes = readRegularFile(join(output, pack.filename));
    const files = [
      {
        name: pack.filename,
        role: "package",
        sha256: sha256(bytes),
        size: bytes.length,
      },
    ];
    for (const file of supplied?.files ?? []) {
      writeFileSync(join(output, file.name), file.bytes, { flag: "wx" });
      const { bytes: _bytes, ...entry } = file;
      files.push(entry);
    }
    if (signed) {
      const after = sourceState(root);
      assertReleaseReady(after, native, supplied.evidence);
      requireValue(
        after.revision === source.revision &&
          sha256(readRegularFile(binary, undefined, true)) === native.sha256,
        "Source or native binary changed during packaging.",
      );
    }
    const manifest = validateManifest(
      {
        manifest_version: 1,
        runtime_version: pkg.version,
        contract_version: build.contract_version,
        mcp_versions: build.mcp_versions,
        platform,
        source_revision: build.source_revision,
        engine: native,
        files,
        acceptance: supplied?.evidence ?? null,
        trust,
      },
      signed,
    );
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(output, "manifest.json"), manifestBytes, { flag: "wx" });
    if (key)
      writeFileSync(
        join(output, "manifest.sig"),
        sign(null, manifestBytes, key).toString("base64") + "\n",
        { flag: "wx" },
      );
    return {
      directory: output,
      package: pack.filename,
      manifest: "manifest.json",
      signed,
      release_eligible: signed,
      source_revision: manifest.source_revision,
      platform,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(packageRelease()));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
