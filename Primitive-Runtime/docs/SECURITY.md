# Execution and trust boundaries

The trusted operator selects workspace bindings, credentials, routes, checks,
maximum budgets and client scopes. Tasks, repository contents, model replies and
edits are untrusted. The local OS account and kernel remain trust boundaries;
this design does not claim to withstand an attacker who fully controls them.

## Restricted native sessions

The modified native executable has a separate `primitive` mode. It does not
attach to a user's daemon, recover ambient sessions, load personal OAuth, install
tools or enable ordinary shell/swarm/update capabilities. Acknowledged policy
binds role, run, generation, owned artifact and read manifest. The adapter checks
the pinned binary's SHA-256 and version before model work begins.

Activator and Diagnosis get read-only retrieval and structured submission.
Primitives get owned reads/proposals, explicit dependency reads, messages,
activation requests and local completion. The host rechecks authority at each
actual effect. Native authorization is not a reusable bearer token.

The shared turn core owns assistant/tool correlation and conversation history.
The trusted host can acknowledge effects; models cannot call init, restore,
complete, reject or cancel protocol operations. Role policy survives history
continuation. Malformed frames, positional arrays, extra fields, reused call IDs,
corrupt snapshots and unacknowledged effects fail closed.

## Files and validation

The workspace layer rejects traversal, control characters, Windows reserved names
and alternate streams, case aliases, symlinks and hard-link aliases. Linux file
operations anchor parents with directory descriptors. An owned path does not come
from a model-supplied patch header. New files require controller reservation.

Primary files are never automatically changed. Hash, version and generation are
checked at the write boundary; candidate and baseline identities are checked
around validation. External source edits produce an explicit conflict. Unchanged
binary assets may be copied, but binary editing is unsupported.

OS sandboxing is separate from staging and model tool restrictions.

| Backend                 | Enforced boundary                                                                                                                                    | Limitations                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Linux x64 bwrap         | Separate namespaces, no network/ambient environment, read-only candidate and trusted tools, seccomp, bounded scratch, parent-death termination       | Per-process virtual-address-space and CPU limits; empty `/proc`; requires kernel namespace support |
| Docker Linux containers | Pinned local image, no network, read-only root, dropped capabilities, no-new-privileges, container memory/PID limits, bounded tmpfs, durable cleanup | Needs a trusted local daemon; real Docker execution remains a separate unverified platform gate    |

A root-run service drops the host identity through `setpriv` before bwrap so UID
0 cannot bypass the claimed process limit. Unsupported isolation never falls back
to host commands. Checks capture command, exit/signal, timeout and bounded output.

Tool mounts are trusted operator inputs. They must contain intended runtimes and
dependencies, not credentials. Candidate code can read everything intentionally
included in its candidate/tool mounts. It does not inherit service keys, HOME,
custom environment or network access. Validation cannot pull missing packages.

## Authentication and configuration

On the tested Unix path, state directories are owner-only, credential/config
files use mode 0600 and sockets are private. Operator and MCP client tokens are
separate. Operator settings keep token hashes; newly provisioned credential files
are written once and never returned as model content. Provider credentials are
explicit environment/file references, not embedded URL credentials.

Run visibility requires principal, tool binding, workspace and profile scope.
Knowing a run ID is insufficient. Browser Origin headers, malformed/oversized
IPC and incompatible contract versions are rejected. Revocation applies to
subsequent calls. Endpoint URLs require HTTPS or loopback HTTP and reject embedded
credentials, query strings and fragments.

Expected revisions prevent lost configuration updates. Accepted run snapshots
are immutable. Write failures restore in-memory settings. The operator interface
is not registered as a public MCP tool. Panel strings are bounded, terminal
control sequences are removed and secret-bearing strings are redacted.

Windows named-pipe paths exist, but this delivery does not assert Windows ACL or
junction-race equivalence. Windows must pass private-file/pipe, workspace, Docker,
packaging and lifecycle tests on Windows before publication.

## Accounting and verification truth

Every run inference attempt, preflight probe, retry and correction shares the run budget.
Concurrent calls reserve input, output and known cost before dispatch. Observed
usage is recorded even for malformed model messages and over-budget replies;
those replies cannot execute tools. Partially missing usage preserves known
counts and estimates only the missing portion.

Unknown price is not zero. Strict dollar budgets require prices for all selected
endpoints. Prices are operator-supplied and reported as `cost_source:
operator_prices`; this is not a reconciled provider invoice. Requested routes
stay pinned; actual model/provider IDs are recorded
only when reported. They do not prove a provider's internal routing or billing.

Compatibility probes check forced tool arguments, a fresh tool-result challenge,
usage and local cancellation. They cannot prove remote inference or billing
stopped after the HTTP connection closed.
Operator-initiated probes have a separate bounded allowance and return their
usage. They are counted as active work for shutdown; stop and close abort and
await their local transport cleanup. A draining service refuses new probes.

Mandatory deterministic checks own `verification`. A model PASS cannot override
failure or absence. Changed test paths and criteria lacking independent proof
remain visible. Successful staging does not imply application or perfect code.

## Cleanup, maintenance and uninstall

Cancellation commits intent before aborting workers and waits for local cleanup.
Failure remains explicit and blocks admission. Restart fences generations and
interrupts abandoned runs without replay. A separate exclusive SQLite ownership
lock avoids stale-PID deletion races among service, doctor and uninstall.
The listener opens only after recovery and initial retention complete. Shutdown
also waits for an already-running retention task before releasing ownership.

Configuration write failures before rename roll back memory and provisional
credentials. A directory-fsync failure after rename instead retains the new
configuration and credentials, exposes `CONFIG_DURABILITY_UNCONFIRMED`, and drains
admission. The operator can inspect the committed revision before retrying.

Docker receipts are retained until cleanup is known. Label/ID mismatches never
cause deletion of an unrelated container. An unknown create outcome requires
operator inspection; discarding its receipt would defeat the guarantee. Retention
does not erase uncertain cleanup evidence.

Initialization requires an empty dedicated directory and writes an ownership
marker. Uninstall checks that marker, source separation, known managed entries,
service ownership and validation receipts. Under the lock it durably marks the
state as deleting, preventing concurrent startup. Arbitrary folders containing
an `operator.json` file are not treated as disposable state.

## Review and publisher trust

Tests exercise actual native denials, path races, messages/completion, real sandbox
isolation, cancellation/SIGKILL and credential scopes. Commands and closed findings
are in [REVIEW.md](REVIEW.md). Scripted provider tests establish runtime semantics,
not benchmark quality or every provider's behavior.

Publisher authenticity uses a separately trusted Ed25519 public key and expected
publisher ID. Signatures cover exact source/engine identity, platform evidence
and artifact hashes. Unsigned or incompletely tested packages stay ineligible for
release; a checksum supplied by an arbitrary publisher is not a trust root.
