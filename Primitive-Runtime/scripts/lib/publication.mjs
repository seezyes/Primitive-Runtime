// The publicly distributed source is only the runtime build-input closure.
export const NATIVE_CRATES = [
  "engine/jcode/modified/primitive",
  "engine/jcode/modified/crates/jcode-message-types",
  "engine/jcode/modified/crates/jcode-session-types",
  "engine/jcode/modified/crates/jcode-turn-core",
];
export const PUBLIC_FILES = [
  "README.public.md", ".gitignore", "package.json", "package-lock.json", "tsconfig.json",
  "config/operator.example.json",
  "contracts/primitive-runtime-actions.schema.json", "contracts/state-v0.1.schema.json",
  "prompts/activator-v1.md", "prompts/diagnosis-v1.md", "prompts/primitive-v1.md",
  "engine/JCODE_PROVENANCE.json", "engine/jcode/modified/LICENSE",
  "packages/operator-tui/package.json", "packages/operator-tui/NOTICE.md",
  "scripts/install.mjs", "scripts/uninstall.mjs", "scripts/package-release.mjs",
  "scripts/verify-release.mjs", "scripts/lib/release.mjs",
  "scripts/lib/state.mjs", "scripts/lib/publication.mjs",
  ...NATIVE_CRATES.map(p => p + "/Cargo.toml"),
  "engine/jcode/modified/primitive/Cargo.lock",
];
const publicExact = new Set(PUBLIC_FILES);
export function isPublicSource(path) {
  return publicExact.has(path) ||
    (path.startsWith("packages/runtime/src/") && path.endsWith(".ts")) ||
    (path.startsWith("packages/operator-tui/src/") && path.endsWith(".mjs")) ||
    (NATIVE_CRATES.some(p => path.startsWith(p + "/src/")) && path.endsWith(".rs"));
}
export const RELEASE_INVENTORY = [
  "dist", "packages/operator-tui/src", "packages/operator-tui/package.json",
  "packages/operator-tui/NOTICE.md", "contracts/primitive-runtime-actions.schema.json",
  "contracts/state-v0.1.schema.json", "prompts/activator-v1.md",
  "prompts/diagnosis-v1.md", "prompts/primitive-v1.md", "config/operator.example.json",
  "licenses", "build-info.json", "npm-shrinkwrap.json", "engine/JCODE_PROVENANCE.json",
  "scripts/install.mjs", "scripts/uninstall.mjs", "scripts/verify-release.mjs",
  "scripts/lib/release.mjs", "scripts/lib/state.mjs",
];
const releaseExact = new Set([
  "README.md", "package.json", "build-info.json", "npm-shrinkwrap.json",
  ...RELEASE_INVENTORY.filter(p => !["dist", "packages/operator-tui/src", "licenses"].includes(p)),
  "licenses/Primitive-Runtime-LICENSE", "licenses/JCode-LICENSE",
]);
export function allowedReleaseFile(path, platform, executable) {
  if (releaseExact.has(path) || path === "bin/" + platform + "/" + executable) return true;
  if (path.includes("..")) return false;
  return /^dist\/runtime\/src\/[a-zA-Z0-9_./-]+\.js$/u.test(path) ||
    /^packages\/operator-tui\/src\/[a-zA-Z0-9_./-]+\.mjs$/u.test(path);
}
