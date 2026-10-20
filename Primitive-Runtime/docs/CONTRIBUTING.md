# Contributing and reproducible verification

Start with [specification v0.2](01_Primitive_Runtime_Spec_v0.2.md),
[architecture](ARCHITECTURE.md), [security boundaries](SECURITY.md) and the
[current review record](REVIEW.md). The specification is preserved as the
requirements source; implementation claims belong in the review record.

## Source rules

Keep repository-root organization to `LICENSE`, `README.md` and the
`Primitive-Runtime/` project directory. Keep edits in their owning subsystem.
Transactions must not cross asynchronous boundaries. Model-facing configuration
must never become an alternate authority channel.

JCode's imported reference in `engine/jcode/upstream/` is immutable. Modify the
working fork in `engine/jcode/modified/` and regenerate its patch. Do not fetch
upstream master during launch. Preserve licenses and truthful provenance.

Use the configured Git identity; do not invent contributors or add automated
coauthor attribution. Review branches isolate acceptance candidates until review.
Do not include runtime databases, credential files, build caches, native target
directories, node_modules or unrelated pre-existing files in commits.

## Build

Use Node.js 24 and the locked dependencies:

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
cargo build --locked --release --manifest-path engine/jcode/modified/primitive/Cargo.toml
cargo test --locked --manifest-path engine/jcode/modified/primitive/Cargo.toml
cargo clippy --locked --manifest-path engine/jcode/modified/primitive/Cargo.toml -p jcode-primitive -p jcode-turn-core --all-targets -- -D warnings
cargo check --locked --manifest-path engine/jcode/modified/Cargo.toml -p jcode-app-core --no-default-features --lib
```

Source builds require Rust. Published platform packages include the restricted
native executable, compiled TypeScript, terminal panel and pinned dependency
lock. The installing user does not compile Rust.

## Acceptance

```sh
npm test
```

The test script runs each `tests/*.test.mjs` directly with Node and preserves its
individual case counts. A nested runner's outer file count must not be reported
as the number of assertions or cases inside the file.

The acceptance and lifecycle suites require Linux x64, the real native release
binary, bwrap, util-linux, Git, local HTTP/Unix sockets and permitted namespaces.
Missing prerequisites are failures, not evidence of passing isolation. Tests
create temporary Git repositories and use a scripted loopback model endpoint.
They must never contact a paid provider or modify a user's source tree.

The required scenarios cover ownership, native restoration, literal in-round
messaging, quiescence races, candidate conflicts, failed/missing validation,
idempotency, lost pipes, scope/revocation, cancellation and SIGKILL recovery.
Native tests additionally cover malformed JSON/schema forms, duplicate IDs,
corrupt history/counters, frame budgets and ordinary/restricted turn-core reuse.

Run tests on each advertised platform. Cross compilation alone is not Windows
acceptance. Real Docker execution, Windows filesystem/pipe ACLs and Windows
process cleanup need their own platform evidence. bwrap's per-process address
space limit must not be reported as an aggregate physical-memory cap.

## Patch provenance

```sh
python3 engine/jcode/regenerate_patch.py
```

The generator compares tracked reference files with the controlled modified tree,
excludes build outputs and emits `engine/jcode/patches/jcode-modifications.patch`.
It does not create a Git commit or require a fabricated identity. Verify that the
patch applies to a clean copy of the imported reference and reproduces every
controlled fork change before delivery.

## Package and publisher trust

```sh
npm run package:release
```

Without a configured publisher key this creates an explicitly unsigned development
package under `release/<platform>/`. It remains `release_eligible: false`.
A signed release requires a clean reviewed source commit, a native executable
built with that exact `PRIMITIVE_ENGINE_SOURCE_REVISION`, matching platform
acceptance evidence and a configured Ed25519 signing key. The packager validates
these inputs; signing alone cannot turn missing tests into a release.

Use the release script's evidence contract in `scripts/lib/release.mjs`. It binds
all eleven gates and the independent review to an exact source commit, binary
hash, platform and nonempty hashed report files. A gate marked failed, skipped
or missing is rejected. Windows evidence must use the Docker isolation backend.
Build the native executable with the reviewed commit, then supply explicit
publisher and evidence paths:

```sh
PRIMITIVE_ENGINE_SOURCE_REVISION="$(git rev-parse HEAD)" cargo build --locked --release --manifest-path engine/jcode/modified/primitive/Cargo.toml
PRIMITIVE_RELEASE_SIGNING_KEY=/absolute/private/publisher-ed25519.pem \
PRIMITIVE_RELEASE_KEY_ID=expected-publisher-id \
PRIMITIVE_RELEASE_ACCEPTANCE=/absolute/evidence/acceptance.json \
PRIMITIVE_RELEASE_DIRECTORY=/absolute/empty-release-directory \
npm run package:release
```

`PRIMITIVE_RELEASE_ENGINE` optionally selects an explicit native binary. Never
check a signing key into the repository.
The verifier takes a separately trusted public key and the expected publisher ID:

```sh
node scripts/verify-release.mjs /absolute/release /absolute/trusted-publisher.pub expected-publisher-id
```

It verifies a nonempty complete manifest, signature and exact artifact bytes.
A public key obtained only from the same untrusted download is not a trust root.

After verification, install the platform package into a new local application
directory with Node.js 24, then run its `scripts/install.mjs` with a new absolute
state directory. Offline `doctor`, the service, MCP and panel use generated
operator/client configuration. No implicit installer or self-updater runs from
MCP.
For a reviewed development package without a publisher signature, the installer
requires the explicit `--allow-unsigned-development` flag; it cannot confer
authenticated release status.

Uninstall is explicit:

```sh
node scripts/uninstall.mjs /absolute/private/primitive-state --delete-runtime-state
```

It checks the marker, exclusive ownership, workspace separation, known inventory
and cleanup receipts. Unknown user files block removal. The application package
itself can be removed separately after the service is stopped.

## Changes to contracts or research claims

Keep the MCP transport version independent from the application and engine
protocol versions. Schema-breaking changes require a new version and fixtures.
Do not infer success from model text, weaken mandatory checks for a fixture or
claim paper scores from scripted provider tests. Comparative experiments follow
[EVALUATION.md](EVALUATION.md), with raw outcomes and denominators published.
