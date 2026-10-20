# Primitive Runtime
## Standalone MCP server with a modified JCode engine

**Status:** preliminary implementation specification; not implemented.  
**Specification version:** 0.2, 2026-10-20.  
**Application contract:** `primitive-runtime/0.1` (proposed).  
**Companion:** `02_Srouter_Integration_Spec_v0.2.md`.

## 1. Decision, naming, and change from v0.1

Build **Primitive Runtime** as an independent project and downloadable MCP server. It contains a modified, pinned JCode engine and implements the complete HERMES-inspired development loop. It must work without Srouter. Srouter will later install and configure the released runtime, provide model routes, and proxy its tool.

Recommended names:

| Surface | Name |
|---|---|
| Project and GitHub title | Primitive Runtime |
| Proposed repository slug and executable | `primitive-runtime` |
| README subtitle | MCP-native multi-agent coding runtime powered by a modified JCode engine |
| Standalone MCP tool | `primitive_runtime` |
| JCode-derived engine, internal name | Primitive Runtime JCode engine |
| Srouter display title | Primitive Runtime |
| Default Srouter wrapper tool name | `srouter_primitive_runtime` |

The repository name is a proposal, not a statement that a repository or release already exists. The word "Agent" belongs in the description rather than the product name: the product runs and coordinates multiple file agents instead of representing one agent.

This document supersedes the v0.1 requirements "SDK first, no fork" and "new worker package inside Srouter". A controlled JCode fork is now a required dependency of this project. Reuse its SDK/runtime interfaces where useful, but do not make correctness depend on unmodified upstream behavior.

Preserved from v0.1: artifact-owned primitives, direct communication, deterministic scheduling, bounded diagnosis/revision loops, staging, explicit approval, and model-independent routing. Added design decisions are stated below as requirements, not as existing JCode or HERMES features. No benchmark score or exact reproduction of the paper is claimed.

## 2. Product boundary

The calling harness delegates a development task and receives a run handle and verified artifacts. Primitive Runtime owns all internal activation, file-agent execution, messaging, editing, validation, and diagnosis. The calling agent must not relay primitive messages or approve every internal scheduling step.

Srouter is an optional consumer and model gateway. The runtime core must not import Srouter modules, read its database, require its Dashboard, or interpret provider-specific Srouter credentials.

```text
Calling harness / MCP client
  -> primitive_runtime tool
     -> lightweight MCP adapter
        -> persistent Primitive Runtime service
           -> durable run store + deterministic controller
           -> Activator
           -> primitive registry + dependency graph + message bus
           -> modified JCode engine: independent file sessions
           -> controlled artifact store + staging workspace
           -> sandboxed validation runner
           -> Diagnosis -> bounded revisions
        <- state, diff, validation evidence, usage
```

The primary agent should avoid editing a delegated scope until the run returns. This is a host-side operating rule, not something an MCP server can enforce on an unmodified external harness. Runtime snapshot checks must detect conflicting external edits rather than assuming exclusive access.

## 3. Repository and implementation structure

Use a TypeScript service for MCP, orchestration, state, and adapters, with the modified JCode engine as a pinned native dependency. This is a proposed implementation choice, not a requirement to rewrite JCode in TypeScript.

```text
primitive-runtime/
  engine/jcode/                  # pinned upstream-derived source and local changes
  packages/runtime/src/
    mcp/                         # model-facing MCP adapter
    control/                     # authenticated operator-only management interface
    controller/                  # run state machine, activation and diagnosis
    primitives/                  # registry, dependency graph, scheduler, messages
    engine/                      # adapter for modified JCode
    workspace/                   # snapshot, ownership, patches, staging, approval
    validation/                  # sandbox and bounded command runner
    models/                      # generic model endpoint profiles
    storage/                     # durable run/event/artifact records
  contracts/                     # schemas, examples and compatibility fixtures
  prompts/                       # versioned Activator/Primitive/Diagnosis prompts
  tests/                         # unit, integration, crash and security cases
  docs/
```

Track the upstream repository, exact upstream commit, local engine commit, SDK version, and patch list. Preserve upstream license texts, attribution, and redistribution requirements. Do not download upstream `master` during normal launch. A release must be independently installable without a Srouter checkout or Rust compilation on the end user's machine.

The exact distribution format and supported platforms are release decisions. Test Windows x64 and Linux x64 first; publish only platforms that pass the standalone acceptance suite. Do not infer platform readiness from the existence of an upstream binary.

## 4. Required JCode modifications

Provide an explicit headless `primitive` execution mode, separate from the user's interactive JCode installation. Names of upstream source modules must be located against the pinned commit during implementation; they are not invented here.

| Required change | Enforced property |
|---|---|
| Role-bound sessions | Activator, Primitive and Diagnosis have explicit, different capabilities. |
| Persistent tool policy | Restore or verify restrictions before any resumed model/tool execution; never recover into default unrestricted tools. |
| Owned-artifact tool enforcement | A Primitive can propose writes only to its registered artifact. Validate inside the execution boundary, not just in prompts or SDK tool descriptions. |
| No unrestricted execution | Disable ordinary shell, arbitrary file writers, recursive swarm spawning, external MCP tools and self-development in primitive mode. |
| Isolated state and configuration | No automatic import of user sessions, ambient tasks, unrelated memory, personal credentials or default tool configuration. |
| Explicit model endpoint configuration | Route model requests through operator-selected generic endpoints, including a Srouter-compatible endpoint. No silent fallback to personal OAuth. |
| Controlled lifecycle | Expose cancellation, policy acknowledgement, bounded execution, usage and tool events through a stable adapter. |
| Fenced recovery | Outputs from a cancelled, superseded or crashed execution generation cannot mutate current artifacts. |

The fork is not "JCode plus a prompt to follow the paper". It must implement the above execution guarantees. Existing upstream facilities may satisfy some requirements, but the modified release must test them explicitly.

Reuse ordinary JCode sessions rather than its stock swarm planner as the source of orchestration decisions. Disable automatic nested spawning: only the deterministic Primitive Runtime controller creates/reassigns primitive sessions.

## 5. Standalone processes and transports

The MVP exposes MCP over **stdio**. Separate the client-launched stdio adapter from the service that owns durable runs. Closing the MCP pipe may terminate the adapter, but must not implicitly destroy an accepted run.

Proposed CLI surface, not existing commands:

```text
primitive-runtime version --json
primitive-runtime doctor --json
primitive-runtime serve --config <operator-config-path>
primitive-runtime mcp --transport stdio --config <client-config-path>
```

`serve` owns the run database and workers. `mcp` connects through an owner-restricted Unix socket or Windows named pipe. Installation or an explicit operator command starts the service; a missing service produces an actionable error rather than silently executing an installer. Persistence and supervision belong to this project, not to the Srouter HTTP request handler.

`stdout` of the MCP adapter is protocol traffic only; diagnostics go to `stderr` or protected logs. The service and adapters must not attach to the user's unrelated JCode daemon.

Compatibility baseline: support MCP `2025-06-18` for the initial integration. Other protocol versions require explicit compatibility tests; the application contract version is separate from the MCP transport/protocol version. Do not depend on newer MCP task extensions for the initial run lifecycle.

Streamable HTTP and a remote workspace agent are later capabilities, not prerequisites for a useful local release. Local sockets do not create filesystem access to a different machine.

## 6. Operator configuration and model profiles

Workspace bindings, model endpoints, credentials, validation commands, and maximum permissions are configured by a trusted operator, outside model-visible arguments.

A model profile maps the roles `activator`, `primitive`, and `diagnosis` to an endpoint and opaque model ID. All three roles may use the same model. Separate role choices are supported; no particular cost/quality advantage is assumed.

Illustrative operator configuration:

```json
{
  "config_version": 1,
  "endpoints": {
    "coding-gateway": {
      "protocol": "openai-chat-completions",
      "base_url": "http://127.0.0.1:20128/v1",
      "credential_ref": "secret:primitive-model-key"
    }
  },
  "model_profiles": {
    "coding-default": {
      "revision": "profile-rev-1",
      "activator": {"endpoint_id": "coding-gateway", "model": "planner-route"},
      "primitive": {"endpoint_id": "coding-gateway", "model": "worker-route"},
      "diagnosis": {"endpoint_id": "coding-gateway", "model": "diagnosis-route"}
    }
  }
}
```

The address, port and model names are examples only. A standalone user can configure a different compatible gateway; the runtime does not require Srouter. Initial API support is limited to the explicitly tested protocol, not every provider advertised by a gateway.

Before admitting a profile, test model selection, tool calls, tool results, cancellation and usage reporting. Generic "chat completion succeeded" is insufficient. Schema-invalid model output receives a bounded correction attempt or an explicit failure.

Store a non-secret resolved configuration snapshot with every run. Profile edits affect new runs, not in-flight runs. Pin routing configuration revisions where possible; log actual resolved models/providers when the endpoint reports them. A route name alone does not prove that its underlying model stayed unchanged.

Credentials remain outside prompts, tool arguments, artifacts and logs. The trusted model client may use a scoped key; primitives and validation processes must not be able to read it. Endpoint URLs may only be changed through operator configuration.

## 7. Dev-Primitive and collaboration contract

A Dev-Primitive is one persistent repository artifact, normally a file, plus a local objective, explicit state, a session, and inbox/outbox records. A primitive may finish without changing its artifact. Persistent new files receive new registered primitives; temporary logs do not.

Minimum record:

```text
primitive_id, run_id, artifact_id, canonical_path,
base_hash, current_hash, artifact_version,
objective, dependency_ids, inbox_cursor,
session_id, execution_generation, policy_revision, state
```

Each artifact has one writer per run. A primitive may read permitted dependencies but cannot take ownership of them by changing a tool argument. A message from another primitive cannot grant permissions.

Internal tools:

| Tool | Contract |
|---|---|
| `read_self` | Read the owned artifact and its version. |
| `read_dependency` | Read an allowed dependency through the artifact service; return its version. |
| `propose_patch` | Submit a patch to the owned artifact with an expected hash/version. |
| `send_message` | Deliver an addressed requirement or observation through the durable message bus. |
| `request_activation` | Ask the controller to register/activate another artifact; does not spawn a child directly. |
| `finish` | Finish this local assignment at a known inbox/version watermark; not the whole run. |

New files, moves and deletions are explicit controller-managed operations. Reserve target paths and create ownership records before writing. In MVP, reject unsupported binary edits, symlink edits and renames with a structured error rather than trying an unrestricted shell workaround.

Messages contain `message_id`, `run_id`, sender and recipient IDs, `round_index`, source artifact version, type, and payload. The bus delivers payloads without an LLM manager paraphrasing them. Persist an outbox transactionally; deduplicate delivery by message ID and record the recipient's processed watermark.

Delivery and processing are different. A recipient must incorporate a relevant message before its assignment can finish. New relevant messages may reactivate a finished primitive in the same round. Bounded queues, message limits, and no-progress detection prevent endless exchanges.

Round quiescence requires no running or runnable assignments, no pending activation decisions, no applicable unprocessed messages, and no in-flight mutation callbacks. Establish the completion barrier and inbox watermarks atomically. Merely counting running agents is insufficient.

## 8. Controller algorithm

1. **Admit and snapshot.** Authenticate, validate profiles and limits, bind workspace, persist an idempotent run record, and capture a consistent baseline. Reject unsupported dirty/untracked workspaces in MVP; do not stash or reset user changes.
2. **Activate.** Activator uses bounded repository retrieval to identify artifacts, dependency relationships, objectives and expected validation impact. Dependency discovery includes tests/configuration/contracts, not only imports. It need not load the entire repository into one prompt.
3. **Collaborate.** Schedule independent file sessions up to the concurrency cap. Stage valid patches, route messages directly, activate missed dependencies, and reject stale proposals.
4. **Reach quiescence.** Freeze an exact candidate revision once all collaboration for that round is settled.
5. **Validate.** Materialize and run the configured checks against that candidate, with no simultaneous primitive writes to the checked snapshot.
6. **Diagnose.** On code/test failure, Diagnosis maps actual evidence to implicated artifacts and local repair instructions. Infrastructure failure is classified separately; missing credentials or sandbox support are not a reason to rewrite source code.
7. **Revise or terminate.** Activator adjusts the active subset. `max_revisions=3` means the initial candidate plus at most three additional repair rounds, not three candidates in total.
8. **Report.** Return the exact candidate identity, diff, changed files, validation evidence, remaining issues and usage. The external agent decides whether the result satisfies the broader user request.

This loop is an implementation proposal preserving the architecture of v0.1. It is described as HERMES-inspired, not as a proven exact reproduction of the paper.

## 9. Filesystem, execution, and application policy

Use a staging worktree/copy and controlled artifact service. Primary project file contents must remain unchanged during agent execution; creating a Git worktree may legitimately update Git worktree metadata. Git worktrees are not security sandboxes.

Normalize paths, reject traversal, and enforce platform-aware case/path identity. For MVP, reject symlink-owned artifacts and do not follow symlinks out of the permitted snapshot. Cover Windows drive paths, junctions, case collisions, hard-link aliases and check/use races. Patches must not smuggle edits to additional paths.

Each patch carries the expected hash, artifact version and execution generation. Accept it only under current ownership; increment the version atomically. Two primitives reading different versions must see those version identities in observations/messages rather than silently sharing mutable buffers.

Validation commands come from a named operator profile, not arbitrary MCP arguments. Execute with an explicit working directory, argument array, resource limits, bounded output, timeout, process-tree cancellation and controlled network access. Use an actual OS/container isolation backend: a command named `test` may itself run arbitrary project code. Do not expose host credentials to the test environment.

Capture command, exit status, timeout/signal, candidate hash and output references. Missing required checks means `verification=unverified`; a model cannot turn failed checks into passing checks or silently weaken the original validation profile. Agent-edited tests are not independent proof of correctness; preserve the original acceptance criteria and highlight test changes in the result.

The mandatory MVP output is **staged changes**, not automatic application. A later operator-only `approved_apply_v1` capability may apply an immutable reviewed candidate. It must bind approval to principal, workspace, run ID, candidate hash, baseline manifest and expiry, then recheck external changes.

Approved application is performed by the runtime, never independently by Srouter. It uses a durable journal, backups, and recovery. Do not claim that a multi-file write on an ordinary filesystem is inherently atomic. On a crash or rollback failure, report `apply_failed` with recovery evidence rather than `applied`. No automatic commit, push, rebase or deployment.

## 10. Public MCP tool and application contract

One standalone tool, `primitive_runtime`, exposes a small action interface. The separate operator-control interface must not be published to the model as additional tools.

| Action | Required arguments beyond `action` | Optional arguments | Meaning |
|---|---|---|---|
| `capabilities` | none | none | Report versions, enabled capabilities and caller-visible workspace/profile IDs. |
| `start` | `client_request_id`, `workspace_id`, `task` | `acceptance_criteria`, `model_profile_id`, `validation_profile_id`, `limits`, `mode` | Persist a run and return its ID promptly. |
| `status` | `run_id` | `after_event_id`, `wait_ms` | Read state and a bounded event page; optional bounded long-poll. |
| `result` | `run_id` | none | Read the result or return a clear not-ready indication. |
| `artifact` | `run_id`, `artifact_id` | `offset`, `max_bytes` | Read a bounded artifact slice, never an arbitrary filesystem path. |
| `cancel` | `run_id` | `reason` | Persist cancellation and stop the run's work, idempotently. |

`mode` defaults to `stage` and has no other MVP value. Omitted profile IDs resolve from operator defaults scoped to the caller/workspace; absent defaults cause `CONFIG_REQUIRED`. Task-level limits may only narrow operator limits. Endpoint URLs, API keys, raw paths, commands, permission changes and claimed principal IDs are not accepted arguments.

Publish action-specific JSON Schemas with unknown-field rejection and bounded strings, arrays and integers. Required identifier strings must be nonempty. Ship schemas and contract fixtures in the runtime release; the Srouter adapter consumes the same definitions rather than maintaining a competing protocol.

Business payloads include `contract_version` and `ok`. Return them as MCP `structuredContent` and matching serialized JSON in a text content block for the compatibility baseline. The MCP SDK owns transport-specific envelopes. These business objects are not a substitute for MCP negotiation or metadata requirements.

A tool execution error sets `ok=false` and MCP `isError=true`. A successful `result` lookup for a failed run sets `ok=true`: the lookup succeeded; the returned `run.state` still reports failure. Do not conflate a run outcome, model output, and a transport error.

### 10.1 Start example

```json
{
  "action": "start",
  "client_request_id": "auth-migration-01",
  "workspace_id": "project-1",
  "task": "Update the authentication API, dependent callers, and tests.",
  "acceptance_criteria": ["Existing required checks pass", "Update all affected callers"],
  "model_profile_id": "coding-default",
  "validation_profile_id": "project-checks",
  "mode": "stage",
  "limits": {"max_parallel": 4, "max_revisions": 3}
}
```

```json
{
  "contract_version": "primitive-runtime/0.1",
  "ok": true,
  "run": {
    "run_id": "pr_run_01",
    "state": "queued",
    "phase": null,
    "verification": "not_run",
    "application": "not_applicable"
  },
  "poll_after_ms": 1500
}
```

### 10.2 State and result semantics

The combined status list in v0.1 is deliberately split into independent fields:

| Field | Values |
|---|---|
| `state` | `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted` |
| `phase` | `null`, `preflight`, `activating`, `collaborating`, `validating`, `diagnosing`, `finalizing` |
| `verification` | `not_run`, `passed`, `failed`, `unverified` |
| `application` | `not_applicable`, `staged`, `applied`, `conflict`, `apply_failed` |

`state=succeeded` requires the configured mandatory checks to pass. It does not mean that every natural-language acceptance criterion was mechanically proven, or that changes were applied. Unchecked criteria remain visible. A run unable to perform required validation terminates `failed` with `verification=unverified` and a specific infrastructure error; this is not evidence that the proposed code is incorrect.

`succeeded`, `failed`, `cancelled` and `interrupted` are terminal execution states. An approved application can subsequently change `application` without rerunning or rewriting the recorded validation result. Results expose `terminal` consistently with `state`.

```json
{
  "contract_version": "primitive-runtime/0.1",
  "ok": true,
  "run": {
    "run_id": "pr_run_01",
    "state": "succeeded",
    "phase": null,
    "verification": "passed",
    "application": "staged",
    "terminal": true
  },
  "candidate": {
    "candidate_id": "candidate_02",
    "candidate_hash": "sha256:example-candidate-hash",
    "baseline_id": "baseline_01",
    "files_changed": ["src/auth.ts", "src/api.ts", "tests/auth.test.ts"],
    "diff_artifact_id": "diff_02"
  },
  "validation": [{"check_id": "unit", "status": "passed", "exit_code": 0}],
  "unverified_acceptance_criteria": [],
  "rounds_used": 2,
  "usage": {"input_tokens": 12000, "output_tokens": 2400, "cost_usd": null, "cost_source": "unknown"},
  "apply_requires_operator_approval": true,
  "warnings": [],
  "error": null
}
```

The example hash and token counts are illustrative, not measurements. Actual usage reports distinguish reported tokens, estimates, unknown pricing and per-role totals.

### 10.3 Identity, retries, and artifacts

Idempotency key: `(authenticated principal, tool binding, client_request_id)`. Persist the canonical request digest and resolved configuration revision with the run. An identical retry returns the same run even if defaults have since changed. Reuse with different explicit arguments returns `IDEMPOTENCY_CONFLICT`, never a second run.

A run ID is not permission to read, cancel, or apply that run. Check authorization on every action, including artifact reads and capability discovery. The principal comes from the authenticated adapter/control boundary, never from model arguments.

`status` returns monotonically ordered event IDs within a run and a continuation cursor when more events remain. Cap the response and `wait_ms` at 10 seconds; return `poll_after_ms` to prevent busy polling. Clients must explicitly fetch details instead of receiving all primitive transcripts by default.

Artifacts are immutable or versioned, scoped to a run and principal, and returned with size/hash/type metadata and truncation/continuation information. Default retention is operator-configurable; the initial suggestion is seven days after terminal execution. Retain idempotency tombstones at least as long and return `RUN_EXPIRED` rather than recreating a paid run after expiry.

Suggested machine-readable errors include `CONFIG_REQUIRED`, `ACCESS_DENIED`, `WORKSPACE_DIRTY`, `UNSUPPORTED_SANDBOX`, `MODEL_ROUTE_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, `PATCH_CONFLICT`, `BUDGET_EXCEEDED`, `TIMEOUT`, `VALIDATION_UNAVAILABLE`, `RUN_NOT_READY`, `RUN_EXPIRED`, and `INCOMPATIBLE_CONTRACT`. Include `retryable` and a safe explanation; retryability does not authorize raising permissions.

## 11. Operator-only control interface

Provide a versioned authenticated local management interface, separate from the model-facing MCP schema. It is used by the standalone CLI and, later, the trusted Srouter backend.

Required operations: inspect runtime/engine versions, upsert workspace bindings, upsert immutable profile revisions, provision/revoke scoped client credentials, inspect run ownership, and stop/drain the service. Workspace/profile changes require expected-revision checks to avoid lost updates.

Optional `approved_apply_v1` adds candidate-specific approval/application and audit queries. No boolean such as `approved:true` accepted from a model is sufficient authority.

The client-facing adapter credential is bound to a principal, tool binding, allowed workspace/profile IDs, and actions. It is not the operator-management credential. The local OS account remains a trust boundary: these controls do not claim to defend against an attacker who fully controls that account.

## 12. Limits, persistence, cancellation, and recovery

Initial configurable defaults, carried forward as engineering starting points rather than benchmark optima:

| Limit | Suggested value |
|---|---:|
| Active runs per workspace | 1 |
| Registered primitives per run | 16 |
| Concurrent primitive executions | 4 |
| Additional repair rounds | 3 |
| Messages per run | 150 |
| Run wall-time | 900 seconds |

Also enforce token limits, output/artifact sizes, file sizes, validation CPU/RAM/process/disk limits, provider retry caps and optional spend limits. Price unknown is not zero cost. A strict dollar budget requires reliable pricing; otherwise report that it is unenforceable and use hard token/time limits or reject that strict-budget configuration.

Persist runs, configuration revisions, baselines, patches, primitive ownership, message outboxes/watermarks, events, artifacts and execution generations in a transactional store. Do not use an MCP connection, HTTP request, or JCode transcript as the authoritative run store.

Cancellation first records intent, rejects new work, fences late callbacks, and terminates model requests and validation process trees. Report `cancelled` only after cleanup acknowledgement or expose an explicit cleanup error. A protocol request timeout is not implicit business cancellation.

On a service crash, retained terminal results remain readable. MVP marks abandoned nonterminal runs `interrupted` after fencing old workers; it must not replay arbitrary side effects or automatically resume JCode with default capabilities. More advanced resumability is a later feature, not necessary to claim durable result storage.

Before validating or approved application, recheck candidate/baseline identities. Nothing generated by the model may change budgets, relax the sandbox, grant another file's ownership, or invoke the public runtime tool recursively.

## 13. Release and acceptance gates

Release versioning must record runtime version, application contract, modified engine commit and supported MCP versions. Provide pinned per-platform artifacts, hashes and a verifiable release manifest; authenticity must be rooted in the configured trusted publisher, not an untrusted checksum supplied alongside an arbitrary binary. Disable self-updates and self-modification during runs.

| Test | Required observation |
|---|---|
| Standalone operation | Complete a multi-file fixture through an ordinary MCP client with no Srouter installed. |
| File ownership | A deliberately misdirected primitive cannot write another artifact through any exposed tool. |
| Restart policy | A crashed/restarted engine never executes with unrestricted default tools. |
| In-round messaging | An interface-change message reaches and reactivates its dependent primitive before the round closes. |
| Quiescence race | A message arriving during completion cannot be dropped or mistaken for completed work. |
| Snapshot conflict | An external workspace edit produces a visible conflict, not a silent overwrite. |
| Validation truth | Failed or absent mandatory checks cannot produce `verification=passed`. |
| Lifecycle | Duplicate start, lost response, pipe close, service crash and cancel races behave as specified. |
| Isolation | Traversal, symlink/junction escape, shell escape, credential access and recursive orchestration are denied. |
| Contracts | Schemas, examples, state transitions and both supported transport/client paths agree. |
| Packaging | Clean installation, diagnostics and uninstall work on each advertised platform. |

Delivery sequence: **R0** pin the fork and enforce restricted headless sessions; **R1** implement the standalone controller, snapshots, messaging and validation; **R2** deliver the MCP/control contract, durable state and release packaging; **R3** run comparative evaluation and enable the separate Srouter integration. Compare plain JCode, file agents without Diagnosis, and the complete loop under controlled model/task/budget conditions. Publish measured outcomes, not transferred paper scores.

## 14. Scope exclusions and references

Not in the initial release: a full coding IDE/TUI, generic marketplace for arbitrary code plugins, transparent interception of every harness tool, distributed execution, a remote workspace bridge, recursive swarms, guaranteed recovery of every in-flight tool, automatic main-workspace edits, or a claim to reproduce HERMES benchmark results.

Design basis: `Srouter_Primitive_Orchestration_Spec_v0.1.md` plus the user's decision to require a standalone MCP project and modified JCode. The HERMES and JCode links below are retained background references from that specification, not a new verification of paper results or current fork capabilities.

- HERMES reference: https://arxiv.org/html/2610.07832v1
- JCode SDK reference: https://github.com/1jehuang/jcode/blob/master/sdk/typescript/README.md
- JCode Swarm reference: https://github.com/1jehuang/jcode/blob/master/docs/SWARM_ARCHITECTURE.md
- MCP compatibility baseline, tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP compatibility baseline, transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

The contract, defaults, CLI, component structure and acceptance gates above are proposed engineering requirements. They must not be described as already released functionality.