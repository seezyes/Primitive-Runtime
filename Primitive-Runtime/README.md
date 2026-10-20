# Primitive Runtime

Primitive Runtime implements the standalone development loop in
[specification v0.2](docs/01_Primitive_Runtime_Spec_v0.2.md). A read-only Activator
assigns one owner to each selected file. Those owners edit staging artifacts and
exchange literal messages. The controller waits for a transactional completion
barrier, validates an immutable candidate in an OS sandbox, and uses read-only
Diagnosis to direct bounded repairs.

The service works without Srouter. Its only public MCP tool is
`primitive_runtime`. Settings belong to a separate authenticated local operator
API and the terminal panel adapted from the supplied `tui-mockup-src.zip`.

**Status:** implemented source and Linux acceptance candidate. See
[REVIEW.md](docs/REVIEW.md) for measured evidence and release gates. An unsigned
development package is not an authenticated publisher release. Windows and real
Docker execution must pass their own acceptance runs before they are advertised
as supported.

## Run behavior

- The primary Git workspace stays unchanged. Each run has a baseline, mutable
  staging tree and immutable validation candidates.
- A primitive can propose changes to its one registered artifact. Hash, version,
  ownership and execution generation are checked at the actual write boundary.
- A message can reactivate a finished dependent primitive within the same round.
  The round cannot close while workers, messages, activations or writes remain.
- Accepted runs survive an MCP pipe closing. Exact retries return the existing
  handle, including after defaults change. A service crash fences and interrupts
  abandoned work instead of replaying it.
- `succeeded` requires actual mandatory checks for the reported candidate and a
  passing Diagnosis. Model text cannot override failed checks. Unchecked natural
  language acceptance criteria stay visible in the result.
- Missing isolation or a mismatched native engine fails closed. There is no host
  execution fallback for tests.

The research motivates the agent organization. This implementation does not
claim its benchmark performance; see [EVALUATION.md](docs/EVALUATION.md).

## Install a prepared platform package

A prepared `.tgz` includes compiled JavaScript, the native engine, terminal panel
and a lockfile for runtime dependencies. Node.js 24 and the Linux sandbox prerequisites
below are still required. Install it into a dedicated application directory:

```sh
mkdir /absolute/primitive-app
cd /absolute/primitive-app
npm install --omit=dev --ignore-scripts /absolute/primitive-runtime-0.1.0.tgz
node node_modules/primitive-runtime/scripts/install.mjs /absolute/primitive-state --allow-unsigned-development
./node_modules/.bin/primitive-runtime serve --config /absolute/primitive-state/operator.json
```

The explicit development flag applies to the review candidate. For a signed
publisher release, verify its manifest with the separately trusted key as
described in [CONTRIBUTING.md](docs/CONTRIBUTING.md), then omit that flag.
Initialization requires a new empty state directory and returns the actual
operator and client configuration paths. Open the panel in another terminal:

```sh
./node_modules/.bin/primitive-runtime tui --config /absolute/primitive-state/operator-client.json
```

Complete the workspace, endpoint, model and check configuration described below.
The MCP executable for this installation is the absolute path to
`node_modules/.bin/primitive-runtime`. Rust and a source checkout are not needed.

## Build and initialize from source

The tested setup is Linux x64, Node.js 24, Git, `bwrap`, and util-linux (`prlimit`,
plus `setpriv` if the service runs as root). The kernel must permit the namespaces
and seccomp restrictions checked by `doctor`. Rust is needed for a source build.
A packaged platform artifact includes the native executable and does not need
Rust on the installing machine.

Run these commands from this directory:

```sh
npm ci --ignore-scripts
cargo build --locked --release --manifest-path engine/jcode/modified/primitive/Cargo.toml
npm run build
node dist/runtime/src/cli.js version --json
```

Use a new, empty state directory outside every bound source workspace. Replace
the example absolute paths with paths on the local machine:

```sh
node dist/runtime/src/cli.js init \
  --state-dir /absolute/private/primitive-state \
  --engine /absolute/Primitive-Runtime/engine/jcode/modified/primitive/target/release/jcode-primitive

node dist/runtime/src/cli.js serve \
  --config /absolute/private/primitive-state/operator.json
```

Keep the service running and open the panel in another terminal:

```sh
node dist/runtime/src/cli.js tui \
  --config /absolute/private/primitive-state/operator-client.json
```

Configure endpoints, role model profiles, validation profiles, workspaces, then
scoped MCP clients. The panel starts empty and edits actual service settings.
Its model profile probe makes bounded inference requests and reports their usage.
Closing the panel leaves the service and accepted runs alive. Instructions are in
[OPERATOR_PANEL.md](docs/OPERATOR_PANEL.md).

With the service stopped, run offline diagnostics:

```sh
node dist/runtime/src/cli.js doctor \
  --config /absolute/private/primitive-state/operator.json --json
```

`doctor` verifies the pinned executable, isolation backends and presence of model
profiles/workspaces. Online inspection and model probes are available through the
panel. Model compatibility probes test a forced tool call, a fresh tool-result
challenge, usage reporting and local transport cancellation. Ordinary chat
success alone does not establish compatibility.

## Connect an MCP client

Provision a scoped credential in the panel and choose a new private output file.
Use that credential, not the operator token:

```json
{
  "mcpServers": {
    "primitive-runtime": {
      "command": "node",
      "args": [
        "/absolute/Primitive-Runtime/dist/runtime/src/cli.js",
        "mcp",
        "--transport",
        "stdio",
        "--config",
        "/absolute/private/coding-client.json"
      ]
    }
  }
}
```

MCP `2025-06-18` is the compatibility baseline. The official SDK handles stdio
framing and negotiation. Results contain identical business JSON in
`structuredContent` and a text block. Adapter stdout is protocol-only. A missing
service produces an actionable error; the adapter never installs or starts one.

Call `primitive_runtime` with:

```json
{
  "action": "start",
  "client_request_id": "change-parser-001",
  "workspace_id": "my-project",
  "task": "Update the parser and affected callers for the revised interface.",
  "acceptance_criteria": ["The configured mandatory checks pass"],
  "limits": { "max_revisions": 3 },
  "mode": "stage"
}
```

| Action         | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `capabilities` | Versions, features and caller-visible workspace/profile IDs    |
| `start`        | Persist a run and return its handle promptly                   |
| `status`       | Bounded event pages and state; optional wait up to ten seconds |
| `result`       | Candidate, checks, Diagnosis, usage and unchecked criteria     |
| `artifact`     | Scoped immutable bytes with hash, size and continuation offset |
| `cancel`       | Fence callbacks and wait for local cleanup                     |

`ok` describes the tool operation. Reading a terminal failed run returns
`ok: true`; `run.state` and `error` describe its execution failure. An unauthorized
lookup returns `ok: false`. A run ID alone grants no access.

Three revisions mean an initial candidate plus three repair rounds, at most four
checked candidates. Zero revisions means one candidate. No automatic application
capability is enabled.

## Operator choices and boundaries

Only the operator sets endpoint URLs, keys, workspace paths, test commands and
maximum limits. The model-facing tool schema cannot change them. Activator,
Primitive and Diagnosis can use distinct opaque model IDs or the same model.
Generic OpenAI Chat Completions endpoints use explicit `env:NAME` or absolute
owner-only `file:` credential references. There is no personal OAuth fallback.

Validation profiles freeze executable/argument arrays, required checks and
resource limits for the entire run. bwrap disables networking, exposes the
candidate and trusted tool directories, uses bounded tmpfs scratch and blocks
new namespace/mount operations. Its address-space and CPU limits are per process;
`/proc` is empty. V8 can need a large virtual address-space allowance even with a
small JavaScript heap. Docker uses digest-pinned local Linux images and container
memory/PID limits; automatic image pulls are disabled.

Test dependencies must already exist in trusted tool directories or the pinned
image. Validation does not perform network installs. Tool directories must not
contain credentials. Default file limits favor small source artifacts; larger
projects need deliberate operator limits. This version rejects symlinks,
hard-link aliases and binary edits.

## Verify and distribute

```sh
npm run typecheck
npm test
cargo test --locked --manifest-path engine/jcode/modified/primitive/Cargo.toml
npm run package:release
```

Acceptance uses an ordinary SDK MCP client, separate service, native engine and
real Linux isolation. A scripted loopback provider replaces paid inference so
races and invalid outputs are reproducible. This proves runtime behavior, not
model quality. The runner needs local sockets, processes and user namespaces.

Packaging produces the native platform package and a manifest. Publication
requires exact reviewed source/engine identities, passing platform evidence and
a configured Ed25519 publisher key. Verification uses a separately trusted public
key and expected publisher ID. An adjacent checksum or self-supplied key does not
establish authenticity. [CONTRIBUTING.md](docs/CONTRIBUTING.md) describes the gates.

The install helper initializes an empty state directory. Uninstall checks its
ownership marker, workspace separation, stopped service and validation cleanup
before removing runtime state. Runtime updates and installation are never model
tools.

## Documentation and provenance

- [Architecture](docs/ARCHITECTURE.md): subsystems, data and lifetimes.
- [Security](docs/SECURITY.md): authority, isolation and explicit limitations.
- [Operator panel](docs/OPERATOR_PANEL.md): setup, keys and controls.
- [Review](docs/REVIEW.md): independent findings and acceptance evidence.
- [Evaluation](docs/EVALUATION.md): scientific comparison protocol.

JCode is pinned to v0.99.0, commit
`774613c90751b6a26ae9eb6a27be6aff3f210062`. Its imported reference remains in
`engine/jcode/upstream/`; changes belong in `modified/` and the generated patch.
[JCODE_PROVENANCE.json](engine/JCODE_PROVENANCE.json) records original import
redactions, actual reuse, licenses and build identities. The redacted reference
is not described as byte-identical to the official release.

The terminal panel retains selected rendering/input concepts from the supplied
archive. Mock actions and arbitrary plugin loading were replaced with the
authenticated control client. Its [NOTICE](packages/operator-tui/NOTICE.md)
records provenance.

Remote workspaces, Srouter integration, automatic application, unrestricted
plugins and automatic run resumption remain outside the initial service scope.
