# Restricted JCode primitive engine

`jcode-primitive` is the native execution boundary used by Primitive Runtime.
It lives inside the pinned JCode fork and uses the same `jcode-turn-core`
request/history/assistant/tool-result state machine as the fork's ordinary
headless `Agent::run_turn`. The core owns the conversation and determines the
ordered pending tool calls, continuation, and completion. Both adapters use
JCode's `ToolCall`, `ToolDefinition`, `Message`, and `ContentBlock` structures;
the restricted policy also uses its `SessionStatus` metadata. The independent
Cargo workspace links this shared core, the message/session leaf crates,
serialization, and SHA-256. It does not link JCode's ordinary tools, daemon,
provider credential loaders, swarm, shell, update, or TUI subsystems.

The TypeScript service owns model HTTP transport, configuration, transactional
durability, artifact I/O, messages, and sandboxed verification. It obtains
each complete model request from native and returns the normalized provider
completion; it does not construct a second authoritative conversation loop.
A model action is executed by that service only after this engine authorizes
the next pending call in that completion. The service must also enforce
ownership and execution generation at the effect boundary: database-only
effects are fenced transactionally; filesystem writes synchronously check the
fence before committing the file and then record the result in SQLite. There
is no distributed transaction spanning the filesystem and database. A crash
between them interrupts the run, which is not resumed automatically.
Authorization is not a transferable bearer token.
All protocol operations belong to this trusted adapter channel and must never
be exposed as model tools. Only the immutable role catalog is sent to models.

## Build and run

```sh
cargo build --locked --release --manifest-path engine/jcode/modified/primitive/Cargo.toml
cargo test --locked --manifest-path engine/jcode/modified/primitive/Cargo.toml
cargo clippy --locked --manifest-path engine/jcode/modified/primitive/Cargo.toml --all-targets -- -D warnings
engine/jcode/modified/primitive/target/release/jcode-primitive version --json
engine/jcode/modified/primitive/target/release/jcode-primitive primitive
```

Release builds set `PRIMITIVE_ENGINE_SOURCE_REVISION` to the reviewed source
commit. The version response explicitly reports `unreleased-source` otherwise.
The source is portable Rust; platform acceptance requires running the complete
runtime test suite on that platform, not just cross-compiling this crate.

To compile and exercise the actual ordinary consumer, from
`engine/jcode/modified` run:

```sh
CARGO_BUILD_JOBS=2 cargo check --locked -p jcode-app-core --no-default-features
CARGO_BUILD_JOBS=2 cargo test --locked -p jcode-app-core --no-default-features keyed_tool_streaming_blocking_loop_isolates_inputs_and_legacy_fallback -- --test-threads=1
```

The ordinary package retains its upstream platform build dependencies,
including OpenSSL development headers and normally `pkg-config` on Linux.
When those headers/libraries are present without `pkg-config`, an explicit
`OPENSSL_INCLUDE_DIR` and `OPENSSL_LIB_DIR` can identify them. They are not
dependencies of the restricted binary. Both workspaces have committed
lockfiles; the upstream source tree is unchanged.

## Shared ordinary execution path

`../crates/jcode-turn-core` extracts the deterministic turn operations from
the pinned ordinary engine. Its public methods perform no I/O and read no
environment, global configuration, session directories, credentials, or tools.

| Original JCode responsibility | Shared core operation | Ordinary adapter use |
|---|---|---|
| Session history assembled for a provider request | `replace_request_context`, `request`, `messages` | `Agent::run_turn` sends the returned history to its injected `Provider` |
| Assistant text/native/reasoning blocks followed by calls | `accept_response` and `assistant_blocks` | The existing ordinary `Session` persists the returned message |
| Ordered local tool dispatch and correlated results | `pending`, `complete_tool` | The registry loop drains the core queue and persists each returned result |
| Recovery, continuation, and cancellation | `abandon_request`, `has_pending`, `phase`, `cancel` | The ordinary outer loop supplies compaction, retries, and shutdown signals |

The source mapping is `crates/jcode-app-core/src/agent/turn_loops.rs`, method
`Agent::run_turn`, and the ordinary persistence methods in
`crates/jcode-base/src/session.rs`. `Agent::run_once` (`jcode run`) and
`run_once_capture_with_display_role` call this modified path in
`agent/turn_execution.rs`. The separate streaming UI loop is unchanged.
Compaction, hooks, memory, provider transport, telemetry, and ordinary tool
registry effects stay in the ordinary outer adapter. Its
`retain_local_calls` operation accounts for upstream provider-executed or
truncated calls; restricted sessions cannot use it to skip pending results.

The primitive adapter in `src/conversation.rs` uses the same core with an
immutable terminal-tool policy, stricter ID reuse checks, and bounded history.
It never calls `replace_request_context` with host-created messages. Its only
history import is replay-validated native conversation data from a completed
assignment. `tests/turn_core.rs` compares the ordinary and restricted core
histories, correlated result ordering, and next-request behavior for the same
scripted completion sequence. Ordinary text completion and restricted
structured completion differ only through the explicit terminal-tool option.

## Wire contract: `primitive-engine/1`

The only execution mode is `primitive`. Requests and responses are one JSON
object per line on stdin/stdout. Diagnostics use stderr. An EOF ends the
process; it never attaches to another daemon or leaves model work behind. An
unterminated or oversized frame is rejected and the process exits. Each frame
is capped at 20 MiB before JSON parsing, and every request requires a nonempty
`id` of at most 256 bytes. Unknown fields are rejected.

Successful response:

```json
{"id":"request-1","ok":true,"result":{}}
```

Failure response:

```json
{"id":"request-1","ok":false,"error":{"code":"TOOL_DENIED","message":"This tool is not available to the session role","retryable":false}}
```

Parsing failures use `id: null`. A failed action is never returned with
`authorized: true` and cannot be interpreted as permission to execute it.

### Initialize

```json
{
  "op":"init",
  "id":"request-1",
  "session_id":"session-a",
  "policy":{
    "run_id":"run-a",
    "role":"primitive",
    "artifact_path":"src/a.ts",
    "allowed_dependencies":["src/b.ts","tests/a.test.ts"],
    "execution_generation":1,
    "policy_revision":"primitive-policy/1",
    "max_tool_calls":100,
    "max_payload_bytes":1048576
  },
  "state":{
    "artifact_hash":null,
    "artifact_version":0,
    "inbox_cursor":0
  }
}
```

The response contains `policy_ack: true`, `policy_hash`, `engine_protocol`,
`execution_generation`, `turn_core_protocol: "jcode-turn/1"`,
`shared_ordinary_turn_core: true`, and the immutable JCode-format `tools`
catalog. `version --json` reports the same two turn-core compatibility markers.
The host and release installer require them before accepting a binary. Each
catalog entry contains `name`, `description`, and `input_schema`. The hash
binds the complete policy, including generation and manifest. Existing session
IDs cannot be reinitialized. There is no default unrestricted policy.

Roles are `activator`, `primitive`, and `diagnosis`. Read-only roles require
`artifact_path: null`, `artifact_hash: null`, and `artifact_version: 0`.
Only a primitive owns one artifact. New files must already be reserved by the
controller; they begin with a null hash and version zero. A hash is either
null for an absent file or lowercase `sha256:<64 hex characters>` of UTF-8
bytes. The host separately validates actual path identity and snapshot state.

`max_tool_calls` is a cumulative cap from 1 to 10,000.
`max_payload_bytes` is a cumulative cap from 1 to 16 MiB, including policy
initialization, provider completions, tool calls, and results. Provider requests
also have a native counter so plain-text correction loops cannot bypass the
call budget. Rejected model calls consume their
call IDs and budgets too. A process accepts at most 16 sessions. Transcript
storage and restoration remain bounded; the host may choose tighter limits.

### Begin a conversation and request a model completion

```json
{"op":"turn_begin","id":"turn-start","session_id":"session-a","execution_generation":1,"system_prompt":"The immutable role prompt.","input":"The task, owned artifact, version, and current messages."}
{"op":"turn_request","id":"model-request","session_id":"session-a","execution_generation":1}
```

`turn_begin` succeeds once, before any tools execute. Its optional `prior`
field accepts the opaque `conversation` from an earlier assignment's native
snapshot, described below. It returns `ready: true`. `turn_request` returns:

```json
{"request_id":"session-a:turn:1","messages":[{"role":"system","content":"The immutable role prompt."},{"role":"user","content":"The task, owned artifact, version, and current messages."}],"tools":[]}
```

The real `tools` array is the complete fixed catalog; the empty array above
only shortens the illustration. `messages` is OpenAI-compatible structured
history. The host forwards it unchanged to the configured provider and must
correlate the completion with exactly this `request_id`:

```json
{"op":"turn_response","id":"model-response","session_id":"session-a","execution_generation":1,"request_id":"session-a:turn:1","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-a","type":"function","function":{"name":"read_self","arguments":"{}"}}]},"stop_reason":"tool_calls"}
```

The response returns ordered raw `tool_calls` and the core's `phase`:
`needs_tools`, `needs_correction`, or `finished`. The raw JSON argument string
is preserved exactly, including malformed JSON, so any rejection can still be
represented as a correlated provider tool result. There can be at most 16
calls in a completion. Their IDs must be unique across the conversation, and
a role's terminal call must be last. Only the first pending call can be
authorized and completed before the next one advances.

An assistant response without calls yields `needs_correction` for every
restricted role. The host can send bounded feedback before requesting again:

```json
{"op":"turn_correction","id":"correction","session_id":"session-a","execution_generation":1,"content":"Use the advertised structured terminal tool."}
```

The provider cannot finish an assignment by writing prose. An acknowledged
successful `finish`, `submit_plan`, or `submit_diagnosis` ends it. Failed
terminal tools leave the conversation runnable. Stale responses, a second
concurrent request, and host calls that differ from the pending completion
are rejected before effects execute.

### Authorize and acknowledge a tool

```json
{"op":"authorize","id":"request-2","session_id":"session-a","execution_generation":1,"tool_call":{"id":"call-a","name":"propose_patch","input":{"expected_hash":null,"expected_version":0,"content":"export const answer = 42;\n"}}}
```

An accepted result has `authorized: true`, the exact `action` object with
`id`, `name`, and `input`, plus the current `policy_hash` and generation. The
service must execute only this validated action. There can be one outstanding
effect per native session, and no call ID can be reused, including a rejected
call ID. Sessions are independent, so the host can schedule primitives in
parallel without interleaving effects within a session.

When `turn_begin` is active, the supplied ID, tool name, and parsed arguments
must exactly match the first call in the native completion queue. Direct
policy-only authorization remains available for boundary tests and diagnostic
adapters, but the production host always starts the native conversation and
requires the shared-turn compatibility markers.

After the controlled host effect, send:

```json
{"op":"complete","id":"request-3","session_id":"session-a","execution_generation":1,"tool_call_id":"call-a","result":{"accepted":true},"is_error":false,"state":{"artifact_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","artifact_version":1,"inbox_cursor":0}}
```

The illustrative digest must be replaced with the actual proposed content's
SHA-256. Successful patches advance the version exactly once, and the engine
recomputes their new content hash. Successful deletion produces a null hash
and advances the version. Other tools and failed patches cannot change owned
hash/version. `content` and `expected_hash` must both be explicit: omitted
content is never interpreted as deletion. NUL-containing binary data and all
extra file/path fields are rejected. The host may reject further file types.

Completion returns `acknowledged`, `state`, `finished`, `tool_calls`, and
`charged_bytes`. Results are recorded using JCode's ordinary tool-message
representation. The engine does not read process environment variables to
load sessions, configurations, credentials, or memory.

If argument JSON is malformed before authorization, or authorization is
denied, the host appends a correlated error through `reject`:

```json
{"op":"reject","id":"tool-rejection","session_id":"session-a","execution_generation":1,"tool_call_id":"call-a","result":{"ok":false,"error":{"code":"INVALID_ARGUMENT","message":"Use the advertised schema."}}}
```

`reject` cannot acknowledge an authorized effect or change artifact/inbox
state. It consumes the pending model call and writes an error `ToolResult` in
native conversation history. Once `authorize` succeeds, even a host failure
must be acknowledged using `complete` with `is_error: true`. Neither route
can substitute the result of another call or replay an effect.

### Role tools

| Role | Tool | Input |
|---|---|---|
| Primitive | `read_self` | `{}` |
| Primitive | `read_dependency` | `{path}` |
| Primitive | `propose_patch` | `{expected_hash, expected_version, content}` |
| Primitive | `send_message` | `{recipient_id, type, payload}` |
| Primitive | `request_activation` | `{path, objective}` |
| Primitive | `finish` | `{artifact_version, inbox_cursor}` |
| Activator, Diagnosis | `list_files` | `{prefix?}` |
| Activator, Diagnosis | `search` | `{query, path?}` |
| Activator, Diagnosis | `read_file` | `{path}` |
| Activator | `submit_plan` | `{assignments:[{path, objective, dependencies, create?}], summary}` |
| Diagnosis | `submit_diagnosis` | `{verdict, evidence, causes:[{path, reason}], guidance:[{path, objective}], summary}` |

Message payloads remain literal strings, with type `interface`, `dependency`,
`behavior`, `test`, `configuration`, `observation`, or `requirement`.
Activation requests do not mutate the allowlist or spawn another agent.
The deterministic host decides whether to register a new artifact/session.
Plan paths must exist in the read manifest unless `create: true` explicitly
requests a controller-managed new artifact. Dependencies may also name other
new artifacts in the same plan; that reference does not grant read access.
Duplicate case-aliased assignment paths are rejected. Diagnosis may name
missing or deleted artifacts as causes, but remains read-only; its `pass`/`fail` verdict is an
observation and can never override mandatory verification results.

Repository paths use slash-separated relative form. Traversal, absolute
paths, Windows drives/alternate streams, backslashes, control characters,
reserved Windows device names, `.git`, and trailing-dot/space aliases are
rejected. Reads require exact membership in the policy's manifest. Junctions,
symlinks, hard links, and time-of-check races require the host artifact
service's actual filesystem checks; this engine makes no OS sandbox claim.

### Completion barrier

`finish` must acknowledge the current artifact version and processed inbox
cursor. A successful `complete` cannot advance the inbox cursor of a pending
finish. If a new relevant message arrived, completion returns
`INBOX_CONFLICT`; the host completes that attempt with `is_error: true`,
incorporates the message, and schedules work before a fresh finish attempt.
The host must commit its round-quiescence barrier transactionally with durable
inbox and activation state. A native session alone cannot establish quiescence
for an entire run.

### Snapshot and restore

```json
{"op":"snapshot","id":"request-4","session_id":"session-a"}
```

The result is the complete restricted session snapshot, containing policy,
state, counters, call IDs, pending-effect identity, effect-audit transcript,
and the optional opaque native `conversation`. The latter includes JCode
messages, provider stop reasons, request/call counters, original argument
strings, subject identity, and an integrity checksum. Snapshots are capped
at 16 MiB; their complete restoration envelope and every output response are
also checked against the 20 MiB frame limit. Stored result strings are charged
including their JSON escaping, rather than just their decoded length.
Snapshots belong in the run store, not in model arguments or ambient JCode
session directories. The host must authenticate and version their storage.

For a new assignment or inbox reactivation, persist `snapshot.conversation`
and supply it as `turn_begin.prior` after a fresh `init`. Only completely
acknowledged histories are importable: no pending provider or tool effects,
cancelled conversation, mismatched role/run/session/artifact/system prompt,
duplicate IDs, corrupt counter, invalid message pairing, or historical
successful effect outside the immutable role catalog. A legitimate denied
ordinary-tool attempt remains in history with its error result. Previous
dependency reads do not grant access in the new assignment; its fresh policy
governs every new action. The controller saves completed native history and
starts with newly incorporated inbox data, rather than resuming old effects.

The conversation checksum detects accidental modification; it is not a
signature or evidence of an authenticated caller. Native data must remain in
trusted host storage. Replay and structural validation cannot prove historical
HTTP responses or filesystem effects against a malicious host that rewrites
both the data and its checksum. The current role and ownership checks still
govern all future effects independently of imported history.

For optional recovery, `init` accepts `restore: <snapshot>`. Restoration
requires the same session/run/role/ownership/limits/policy revision and a
strictly higher generation. It rejects mismatched state, changed policy,
cancelled/finished sessions, corrupt counters, and any unacknowledged effect.
The host fences old workers before authorizing a fresh generation. The MVP
service marks abandoned runs `interrupted`; this primitive restore protocol
does not authorize automatic run resumption or side-effect replay.

### Cancellation

```json
{"op":"cancel","id":"request-5","session_id":"session-a","execution_generation":1}
```

Cancellation is idempotent and returns `cancelled: true` and
`cleanup_ack: true`. Every subsequent authorization or tool result is fenced.
The engine owns no model requests, child processes, or filesystem handles;
the host must acknowledge its own HTTP/sandbox cleanup before declaring the
whole run cancelled. Old-generation callbacks always fail closed.
