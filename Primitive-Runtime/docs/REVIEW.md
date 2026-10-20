# Review and acceptance record

Status: **independent implementation review and Linux verification completed**.
The restricted engine, control service, operator panel and Linux acceptance
suite have undergone independent automated review. No open P0/P1 findings remain
in the checked scope. The actual ordinary JCode consumer compiles, its existing
blocking-loop regression passes, and the complete runtime acceptance run passes.

This is a review candidate for the standalone R0–R2 scope. Maintainer acceptance
is performed through the pull request. A development package is explicitly
unsigned and cannot serve as evidence of an authenticated publisher release.

## Review method and evidence

Separate agents reviewed subsystems written by other agents. Review included
source inspection, deliberately malformed inputs, actual native processes,
HTTP and private sockets, an ordinary MCP SDK client, crash injection and real
Linux bwrap isolation. Findings were reproduced, corrected and tested again.
The model endpoint in acceptance is an explicit scripted loopback provider;
these results measure runtime semantics and do not claim real-model task quality.

Verification environment: Linux x64, glibc 2.39, Node.js 24.19.0 and
Rust 1.99.1. The final pre-commit restricted binary has SHA-256
`a9a89179cf840586b3eb3a49fa4264749cf78fdbc4d43a17e0e2e5dab3eca96b`.
A later source-stamped package has its own exact binary hash in its manifest;
embedding the reviewed commit changes the executable's version metadata.

| Verification                              | Result and scope                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript build and strict type checking | Passed, including unused-local and unused-parameter checks                                                                                                                      |
| Final complete JS/TS acceptance           | 100 passed in 12 files, zero failures, cancellations, skips or TODO cases                                                                                                       |
| New required JS/TS regressions            | Lost start response, shipped JSON examples and more than 32 MiB cumulative native traffic passed individually                                                                   |
| Native Rust suite                         | 35 passed: 2 framing, 20 policy boundary, 2 subprocess and 11 shared-turn-core cases                                                                                            |
| Native/core Clippy                        | Passed for both `jcode-primitive` and `jcode-turn-core`, all targets, warnings denied                                                                                           |
| Independent adversarial native review     | 74 turn-protocol assertions and 26 earlier boundary regressions passed on the binary above                                                                                      |
| Ordinary `jcode-app-core` consumer        | Compilation passed with locked dependencies and no default features; one existing blocking-loop regression passed                                                               |
| Formatting                                | Prettier checked for the maintained JS/TS surfaces; Rust formatting checked by the native owner                                                                                 |
| Clean package smoke                       | Actual unsigned package installs into a fresh prefix, reports pinned engine identity, runs doctor and uninstalls; runtime package includes README, TUI notice and both licenses |
| Patch reproduction                        | Passed: generated patch applies to the clean frozen reference and reproduces tree `c75c3d0314cd8a5011b5cd7d8334ae4b20ff994b` exactly                                            |

## Findings closed during review

| Finding                                                                                             | Correction and confirming boundary                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusing only JCode message/session metadata did not meet the ordinary-session requirement           | Extracted `jcode-turn-core`; ordinary nonstreaming `Agent::run_turn` and restricted `Conversation` now share request history, assistant assembly, ordered calls/results and continuation. Behavioral parity is tested and the actual ordinary consumer compiles successfully. |
| Native structs could accept positional JSON arrays                                                  | Explicit object and nested-object guards reject arrays at the actual native boundary.                                                                                                                                                                                         |
| Restore accepted inconsistent history and counters                                                  | Correlated replay, immutable subject/policy checks, generation fencing and counter validation reject corrupted snapshots.                                                                                                                                                     |
| A recomputed conversation checksum could introduce an impossible successful historical shell effect | Successful historical effects must belong to the immutable role catalog. Legitimate denied attempts remain errors; a conversation never grants current authority.                                                                                                             |
| JSON escaping could exceed the serialized snapshot budget                                           | Bounds use serialized bytes before acknowledgement.                                                                                                                                                                                                                           |
| Native stdout was capped over the whole process lifetime                                            | The bridge now bounds each frame and assembles chunks once; a real session with over 40 MiB cumulative replies completes successfully.                                                                                                                                        |
| Native and host handwritten tool bounds differed                                                    | The acknowledged native catalog is authoritative; shared schema-agreement cases cover remaining host validation.                                                                                                                                                              |
| Actual model usage could exceed a reservation or disappear on malformed output                      | Observed usage is persisted before payload validation. Over-budget replies cannot execute tools; partial reports preserve known counts.                                                                                                                                       |
| Unknown prices could be mistaken for zero                                                           | Unknown cost stays explicit; strict dollar budgets require configured prices. Operator-calculated costs are labeled `operator_prices`.                                                                                                                                        |
| Dependency bytes and their reported version could race                                              | A bounded read/hash/version check retries conflicts.                                                                                                                                                                                                                          |
| A finish snapshot could overwrite a concurrent reactivation                                         | The host refreshes durable primitive state after the asynchronous native snapshot.                                                                                                                                                                                            |
| A worker failure could wait on uncancelled siblings                                                 | Shared execution is aborted before awaiting all worker cleanup.                                                                                                                                                                                                               |
| Configuration write failure could leave memory and disk with different authority                    | Pre-rename failures roll back; post-rename directory-fsync uncertainty keeps committed settings and credentials, reports `CONFIG_DURABILITY_UNCONFIRMED`, and drains admission. Both provision and revoke paths are tested.                                                   |
| Unknown sandbox cleanup could free admission or erase evidence                                      | Cleanup errors remain explicit, block new work and require lease recovery before expiry.                                                                                                                                                                                      |
| A stale PID-file unlink could race another owner                                                    | Service, offline doctor and uninstall share a separate OS-backed SQLite exclusive lock. Crash releases the lock; the PID file is diagnostic.                                                                                                                                  |
| Physical workspace aliases could admit concurrent runs                                              | Admission checks real directory identity, including aliases under separate binding IDs.                                                                                                                                                                                       |
| Initial retention failure could leave a listener after startup failed                               | Recovery and initial retention precede listener creation; failure closes any created listener before releasing ownership.                                                                                                                                                     |
| Stop/close did not account for operator model probes                                                | Active probes are bounded, aborted and awaited during shutdown; draining rejects new probes. Tests hold a real HTTP request open.                                                                                                                                             |
| Retention could race shutdown or expire payloads before deletion                                    | One shared retention task removes read-only owned trees before expiry; shutdown awaits it before closing the database.                                                                                                                                                        |
| Init/uninstall could adopt or delete existing source                                                | Empty dedicated state, ownership marker, known inventory, root/path/workspace overlap checks, exclusive ownership and durable deleting state prevent this.                                                                                                                    |
| Signed manifests could omit source/platform/review evidence                                         | Strict complete manifests bind every gate, review report, source commit, binary identity and package/report byte hash.                                                                                                                                                        |
| Contract examples were not checked against the actual schema                                        | Tests validate shipped examples through the runtime parser and AJV; the missing `run.terminal` field was corrected.                                                                                                                                                           |
| Lost response was covered only after obtaining a handle                                             | A real start response is destroyed unread; a new MCP adapter retries and observes one stored run, one activation and no duplicate model work.                                                                                                                                 |
| Panel rendered the new engine inspection object as text                                             | The service view now displays native name/version and availability, active probes, maintenance errors and disconnection state.                                                                                                                                                |
| Ordinary source import omitted a README required by the build script                                | The exact pinned upstream README is restored only in the modified tree; the frozen imported reference stays unchanged.                                                                                                                                                        |

### Final clean-source installation correction

Packaging from a fresh checkout exposed a declared Prettier development
dependency missing from `package-lock.json`; `npm ci` correctly refused it.
The lockfile now records the already-selected `prettier@3.6.2`. Independent
review confirmed that the 17 added lines change only the root development
dependency and its development-only package entry. Every existing package,
including all runtime resolutions and integrity values, remains identical.

A clean `npm ci --offline --ignore-scripts --no-audit --no-fund`, with no
overriding shrinkwrap, passed with exit 0 and installed 99 packages. Production
source and the native patch did not change after the complete acceptance run.
The final package is rebuilt with the resulting exact source commit.

## Specification v0.2 acceptance matrix

These observations apply to the tested Linux x64 configuration.

| Section 13 gate      | Reproducible evidence                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone operation | `acceptance.test.mjs`: ordinary MCP client, separate service/native processes, a two-file interface change and real bwrap; no Srouter.                                                                                            |
| File ownership       | Native `policy_boundary.rs` plus `workspace.test.mjs`: misdirected paths, role changes, foreign dependencies, CAS and cancelled-generation writes are denied.                                                                     |
| Restart policy       | Native restore/corruption cases plus actual service SIGKILL and restart in `lifecycle.test.mjs`: abandoned work becomes interrupted and effects are not replayed.                                                                 |
| In-round messaging   | Acceptance checks the literal payload, dependent reactivation, repeated finish of the same file session and event ordering before validation.                                                                                     |
| Quiescence race      | `runtime-core.test.mjs` and native watermark tests cover both message/finish orders, stale inbox cursors and duplicate delivery.                                                                                                  |
| Snapshot conflict    | Real external edits in acceptance and dirty/index-flag/path races in workspace tests produce visible conflicts without source overwrite.                                                                                          |
| Validation truth     | Failed, absent and unavailable mandatory checks cannot become passing through model PASS. Zero revisions means one candidate; three additional repairs mean four.                                                                 |
| Lifecycle            | Eight cases cover idempotency, unread lost start response, stdio closure, mutable defaults, authorization/revocation, HTTP/native/sandbox cancellation, crash and wall timeout. Maintenance adds owner-lock and cleanup recovery. |
| Isolation            | Real Linux path, credential, network, mount, process, scratch-disk, timeout and parent-death tests. Native ordinary tools and recursive orchestration are denied.                                                                 |
| Contracts            | Four contract cases validate actions, state and shipped examples; actual MCP structured/text results, error semantics and native/host schemas agree.                                                                              |
| Packaging            | Twelve release cases include actual clean installation, diagnostics, native provenance and uninstall. Publisher trust tests use explicitly synthetic evidence, never claimed as real signed-release acceptance.                   |

## Ordinary JCode reuse and scope

The source mapping is `engine/jcode/modified/crates/jcode-app-core/src/agent/turn_loops.rs`,
method `Agent::run_turn`. `Agent::run_once` and its capture path reach this loop.
The extracted `jcode-turn-core` owns provider request history, assistant message
assembly and ordered tool-result correlation for both the ordinary loop and
restricted sessions. The restricted host supplies HTTP and controlled effects;
it cannot replace native history with its own transcript.

The executed ordinary regression is
`agent::tests::tool_streaming::keyed_tool_streaming_blocking_loop_isolates_inputs_and_legacy_fallback`.
It passes through the actual ordinary consumer with an injected provider and
capture tool. This targeted invocation runs one test; the other 1,626 upstream
unit tests are filtered out. The full upstream JCode test suite is not claimed.

The ordinary outer adapter keeps compaction, hooks, provider transport and its
registry. The separate streaming UI loop is unchanged. The small restricted
binary does not link the stock daemon, unrestricted tools or personal credential
loaders. Protocol operations are a trusted adapter boundary, not model tools.
Conversation checksums detect corruption; they are not authentication against
an operator who controls the state directory. Current policy is acknowledged
before each assignment, regardless of retained conversation history.

## Platform, publication and scientific limits

Linux x64 with bwrap is exercised using real isolation and process lifecycle.
The tested glibc version is recorded above; this is not a claim about every Linux
distribution. bwrap's address-space and CPU limits are per process, not aggregate
physical-memory limits, and its `/proc` mount is intentionally empty.

Docker receipt recovery has deterministic fixture coverage. Actual Docker daemon
execution, Windows named-pipe ACLs, junctions and process cleanup are not verified
here. These platforms/backends need real acceptance before being advertised as
supported. Cross-compilation or portable source alone is insufficient.

Publisher authenticity requires a separately trusted Ed25519 key and publisher
identity, a clean exact source commit, a native build stamped with that commit
and complete platform/review evidence. The development package remains
`release_eligible: false`. Signature unit tests do not supply a trusted publisher.

Runtime mechanism acceptance is not a HERMES benchmark claim. R3 comparative
real-model evaluation and separate Srouter integration remain later milestones
in [EVALUATION.md](EVALUATION.md). No benchmark score, measured cost advantage or
remote-provider billing cancellation is asserted. Agent-edited tests and
unproven natural-language criteria remain visible in run results.
