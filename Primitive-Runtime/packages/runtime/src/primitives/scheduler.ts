import type { ExecutionContext } from "../controller/context.js";
import { assertCurrent, prompt } from "../controller/context.js";
import { invokeRole } from "../controller/roles.js";
import {
  NativeSession,
  POLICY_REVISION,
  type EngineState,
} from "../engine/native.js";
import { readArtifact, writeArtifact } from "../workspace/index.js";
import type { ActivationPlan, PrimitiveRecord } from "../types.js";
import { check, RuntimeError, safeError } from "../errors.js";
import { identifier, hash } from "../util.js";

function pathIdentity(path: string): string {
  check(
    path.length > 0 &&
      !path.includes("\\") &&
      !path.startsWith("/") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (s) =>
            s &&
            s !== "." &&
            s !== ".." &&
            !s.endsWith(".") &&
            !s.endsWith(" "),
        ),
    "ACCESS_DENIED",
    "Invalid artifact path.",
  );
  return path.normalize("NFC").toLowerCase();
}
export async function registerPlan(
  ctx: ExecutionContext,
  plan: ActivationPlan,
  replaceActive = true,
): Promise<void> {
  assertCurrent(ctx);
  const all = ctx.store.primitives(ctx.runId);
  const byPath = new Map(all.map((p) => [p.canonical_path, p]));
  const reserved = new Map(
    [...Object.keys(ctx.snapshot.manifest), ...byPath.keys()].map((p) => [
      pathIdentity(p),
      p,
    ]),
  );
  const duplicates = new Set<string>();
  for (const a of plan.assignments) {
    const identity = pathIdentity(a.path);
    check(
      !duplicates.has(identity),
      "INVALID_ARGUMENT",
      "A plan cannot assign two writers to one artifact.",
    );
    duplicates.add(identity);
    check(
      !reserved.has(identity) || reserved.get(identity) === a.path,
      "ACCESS_DENIED",
      "Artifact path aliases an existing path.",
    );
    reserved.set(identity, a.path);
    for (const dep of a.dependencies) {
      pathIdentity(dep);
      check(
        Object.hasOwn(ctx.snapshot.manifest, dep) ||
          byPath.has(dep) ||
          plan.assignments.some((x) => x.path === dep),
        "ACCESS_DENIED",
        "Dependency is not a registered artifact.",
      );
    }
  }
  check(
    new Set([...byPath.keys(), ...plan.assignments.map((a) => a.path)]).size <=
      ctx.config.limits.max_primitives,
    "BUDGET_EXCEEDED",
    "Registered primitive limit exceeded.",
  );
  if (replaceActive)
    for (const p of all) {
      p.state = "inactive";
      ctx.store.savePrimitive(p);
    }
  for (const a of plan.assignments) {
    assertCurrent(ctx);
    let p = byPath.get(a.path);
    if (!p) {
      const baseline = ctx.snapshot.manifest[a.path];
      check(
        baseline || a.create === true,
        "INVALID_ARGUMENT",
        "New files require explicit create:true reservation.",
      );
      if (baseline)
        await readArtifact(
          ctx.snapshot.root,
          a.path,
          ctx.config.limits.max_file_bytes,
        );
      p = {
        primitive_id: identifier("primitive"),
        run_id: ctx.runId,
        artifact_id: identifier("owned"),
        canonical_path: a.path,
        base_hash: baseline?.hash ?? null,
        current_hash: baseline?.hash ?? null,
        artifact_version: 0,
        objective: a.objective,
        dependency_ids: a.dependencies,
        inbox_cursor: 0,
        session_id: identifier("session"),
        execution_generation: ctx.generation,
        policy_revision: POLICY_REVISION,
        state: "runnable",
        round_index: ctx.store.getRun(ctx.runId)!.round_index,
        turns: 0,
        tool_calls: 0,
        seen_tool_ids: [],
      };
    } else {
      p.objective = a.objective;
      p.dependency_ids = a.dependencies;
      p.state = "runnable";
      p.round_index = ctx.store.getRun(ctx.runId)!.round_index;
    }
    ctx.store.savePrimitive(p);
    byPath.set(a.path, p);
    ctx.store.event(ctx.runId, "primitive_activated", {
      primitive_id: p.primitive_id,
      path: p.canonical_path,
      round_index: p.round_index,
    });
  }
}
interface ActivationRequest {
  path: string;
  objective: string;
  source: string;
}
function state(p: PrimitiveRecord): EngineState {
  return {
    artifact_hash: p.current_hash,
    artifact_version: p.artifact_version,
    inbox_cursor: p.inbox_cursor,
  };
}
async function executePrimitive(
  ctx: ExecutionContext,
  id: string,
  activationRequests: ActivationRequest[],
): Promise<void> {
  let p = ctx.store.primitive(id)!;
  p.state = "running";
  ctx.store.savePrimitive(p);
  const inbox = ctx.store.inbox(ctx.runId, id, p.inbox_cursor);
  const cursor = inbox.at(-1)?.sequence ?? p.inbox_cursor;
  p.inbox_cursor = cursor;
  ctx.store.savePrimitive(p);
  check(
    p.tool_calls < ctx.config.limits.max_tool_calls,
    "BUDGET_EXCEEDED",
    "Persistent primitive tool budget exhausted.",
  );
  const session = new NativeSession(
    ctx.config.engine,
    p.session_id,
    {
      run_id: ctx.runId,
      role: "primitive",
      artifact_path: p.canonical_path,
      allowed_dependencies: p.dependency_ids,
      execution_generation: ctx.generation,
      policy_revision: POLICY_REVISION,
      max_tool_calls: ctx.config.limits.max_tool_calls - p.tool_calls,
      max_payload_bytes: 16777216,
    },
    ctx.signal,
  );
  const peers = ctx.store
    .primitives(ctx.runId)
    .filter(
      (other) =>
        p.dependency_ids.includes(other.canonical_path) ||
        other.dependency_ids.includes(p.canonical_path),
    )
    .map((x) => ({
      primitive_id: x.primitive_id,
      path: x.canonical_path,
      artifact_version: x.artifact_version,
    }));
  const assignment = JSON.stringify({
    task: ctx.store.getRun(ctx.runId)!.request.task,
    artifact: p.canonical_path,
    objective: p.objective,
    artifact_hash: p.current_hash,
    artifact_version: p.artifact_version,
    inbox_cursor: p.inbox_cursor,
    allowed_dependencies: p.dependency_ids,
    peers,
    messages: inbox,
  });
  const saveConversation = async () => {
    const snapshot = (await session.snapshot()) as { conversation?: unknown };
    check(
      snapshot.conversation !== undefined,
      "ENGINE_PROTOCOL_ERROR",
      "Native session did not return its conversation state.",
    );
    p = ctx.store.primitive(id)!;
    p.native_snapshot = snapshot;
    p.conversation = snapshot.conversation;
    ctx.store.savePrimitive(p);
  };
  let corrections = 0;
  let finished = false;
  try {
    await session.initialize(state(p));
    await session.beginTurn(prompt("primitive"), assignment, p.conversation);
    for (let turn = 0; turn < ctx.config.limits.max_tool_calls; turn++) {
      assertCurrent(ctx);
      p = ctx.store.primitive(id)!;
      p.turns++;
      check(
        p.turns <= ctx.config.limits.max_tool_calls,
        "BUDGET_EXCEEDED",
        "Primitive turn budget exhausted.",
      );
      ctx.store.savePrimitive(p);
      const request = await session.requestTurn();
      const completion = await ctx.model.complete(
        "primitive",
        request.messages,
        session.tools,
      );
      const calls = await session.respondTurn(
        request.request_id,
        completion.message,
        completion.stopReason,
      );
      if (!calls.length) {
        check(
          corrections++ < ctx.config.limits.max_schema_corrections,
          "MODEL_OUTPUT_INVALID",
          "Primitive did not finish using finish.",
        );
        await session.correctTurn(
          "Use the provided tools. Call finish with the current artifact_version and inbox_cursor when your assignment is complete.",
        );
        continue;
      }
      for (const call of calls) {
        assertCurrent(ctx);
        p = ctx.store.primitive(id)!;
        let output: unknown;
        let error = false;
        let authorized = false;
        try {
          p.tool_calls++;
          check(
            p.tool_calls <= ctx.config.limits.max_tool_calls,
            "BUDGET_EXCEEDED",
            "Persistent primitive tool budget exhausted.",
          );
          const duplicate = p.seen_tool_ids.includes(call.id);
          if (!duplicate) p.seen_tool_ids.push(call.id);
          ctx.store.savePrimitive(p);
          check(
            !duplicate,
            "DUPLICATE_TOOL_CALL",
            "Tool call ID was already used by this primitive.",
          );
          const input = JSON.parse(call.function.arguments);
          await session.authorize(call.id, call.function.name, input);
          authorized = true;
          assertCurrent(ctx);
          switch (call.function.name) {
            case "read_self":
              output =
                p.current_hash === null
                  ? {
                      path: p.canonical_path,
                      content: null,
                      hash: null,
                      artifact_version: p.artifact_version,
                    }
                  : {
                      ...(await readArtifact(
                        ctx.snapshot.root,
                        p.canonical_path,
                        ctx.config.limits.max_file_bytes,
                      )),
                      artifact_version: p.artifact_version,
                    };
              break;
            case "read_dependency": {
              check(
                p.dependency_ids.includes(input.path),
                "ACCESS_DENIED",
                "Dependency read is not permitted.",
              );
              let matched = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                const before = ctx.store
                  .primitives(ctx.runId)
                  .find((q) => q.canonical_path === input.path);
                if (before?.current_hash === null) {
                  output = {
                    path: input.path,
                    content: null,
                    hash: null,
                    artifact_version: before.artifact_version,
                  };
                  matched = true;
                  break;
                }
                const file = await readArtifact(
                  ctx.snapshot.root,
                  input.path,
                  ctx.config.limits.max_file_bytes,
                );
                const after = ctx.store
                  .primitives(ctx.runId)
                  .find((q) => q.canonical_path === input.path);
                if (!after || after.current_hash === file.hash) {
                  output = {
                    ...file,
                    path: input.path,
                    artifact_version: after?.artifact_version ?? 0,
                  };
                  matched = true;
                  break;
                }
              }
              check(
                matched,
                "PATCH_CONFLICT",
                "Dependency changed repeatedly while being read.",
              );
              break;
            }
            case "propose_patch": {
              check(
                input.expected_hash === p.current_hash &&
                  input.expected_version === p.artifact_version,
                "PATCH_CONFLICT",
                "Patch uses a stale artifact version.",
              );
              check(
                input.content === null ||
                  Buffer.byteLength(input.content) <=
                    ctx.config.limits.max_file_bytes,
                "BUDGET_EXCEEDED",
                "File size limit exceeded.",
              );
              const next = await writeArtifact(
                ctx.snapshot.root,
                p.canonical_path,
                input.content,
                p.current_hash,
                () => assertCurrent(ctx),
              );
              assertCurrent(ctx);
              p.current_hash = next.hash;
              p.artifact_version++;
              ctx.store.savePrimitive(p);
              output = {
                hash: next.hash,
                artifact_version: p.artifact_version,
              };
              ctx.store.event(ctx.runId, "patch_staged", {
                primitive_id: id,
                path: p.canonical_path,
                artifact_version: p.artifact_version,
              });
              break;
            }
            case "send_message": {
              const recipient = ctx.store.primitive(input.recipient_id);
              check(
                recipient &&
                  (p.dependency_ids.includes(recipient.canonical_path) ||
                    recipient.dependency_ids.includes(p.canonical_path)),
                "ACCESS_DENIED",
                "Messages must address an explicitly related primitive.",
              );
              output = ctx.store.send(
                ctx.runId,
                ctx.generation,
                id,
                input.recipient_id,
                input.type,
                input.payload,
                hash(id + ":" + call.id),
              );
              break;
            }
            case "request_activation":
              pathIdentity(input.path);
              check(
                activationRequests.length < ctx.config.limits.max_primitives,
                "BUDGET_EXCEEDED",
                "Pending activation budget exhausted.",
              );
              if (
                !activationRequests.some(
                  (r) => r.path === input.path && r.source === id,
                )
              )
                activationRequests.push({
                  path: input.path,
                  objective: input.objective,
                  source: id,
                });
              output = { queued: true, controller_decision_required: true };
              break;
            case "finish":
              finished = ctx.store.finishPrimitive(
                id,
                ctx.generation,
                input.artifact_version,
                input.inbox_cursor,
              );
              output = {
                finished,
                reason: finished
                  ? null
                  : "New inbox messages require another assignment.",
              };
              break;
            default:
              throw new RuntimeError(
                "ACCESS_DENIED",
                "Tool is not available to a primitive.",
              );
          }
        } catch (caught) {
          if (
            caught instanceof RuntimeError &&
            ["CANCELLED", "STALE_EXECUTION", "BUDGET_EXCEEDED"].includes(
              caught.code,
            )
          )
            throw caught;
          check(
            corrections++ < ctx.config.limits.max_schema_corrections,
            "MODEL_OUTPUT_INVALID",
            "Primitive correction budget exhausted.",
          );
          error = true;
          output = {
            ok: false,
            error:
              caught instanceof RuntimeError
                ? safeError(caught)
                : {
                    code: "INVALID_ARGUMENT",
                    message: "Tool arguments must match the advertised schema.",
                  },
          };
        }
        p = ctx.store.primitive(id)!;
        if (authorized)
          await session.complete(call.id, output, error, state(p));
        else await session.reject(call.id, output);
        if (finished) {
          check(
            calls.at(-1) === call,
            "MODEL_OUTPUT_INVALID",
            "finish must be the last tool call in a turn.",
          );
          await saveConversation();
          return;
        }
        if (call.function.name === "finish" && !error) {
          p = ctx.store.primitive(id)!;
          p.state = "runnable";
          ctx.store.savePrimitive(p);
          await saveConversation();
          return;
        }
      }
      // Incorporation uses a fresh assignment so the native policy acknowledges the new watermark.
      if (ctx.store.inbox(ctx.runId, id, p.inbox_cursor).length) {
        p = ctx.store.primitive(id)!;
        p.state = "runnable";
        ctx.store.savePrimitive(p);
        await saveConversation();
        return;
      }
    }
    throw new RuntimeError(
      "BUDGET_EXCEEDED",
      "Primitive did not reach completion within its tool budget.",
    );
  } finally {
    await session.close();
  }
}
/** The single-threaded controller owns the barrier; in-flight sessions and mutations are awaited. */
export async function collaborate(ctx: ExecutionContext): Promise<void> {
  const running = new Map<string, Promise<{ id: string; error?: unknown }>>();
  const activationRequests: ActivationRequest[] = [];
  let activationDecisions = 0;
  try {
    while (true) {
      assertCurrent(ctx);
      for (const p of ctx.store.primitives(ctx.runId)) {
        if (running.size >= ctx.config.limits.max_parallel) break;
        if (p.state === "runnable" && !running.has(p.primitive_id)) {
          const id = p.primitive_id;
          const job = executePrimitive(ctx, id, activationRequests).then(
            () => ({ id }),
            (error) => ({ id, error }),
          );
          running.set(id, job);
        }
      }
      if (running.size) {
        const completed = await Promise.race(running.values());
        running.delete(completed.id);
        if (completed.error) throw completed.error;
        continue;
      }
      if (activationRequests.length) {
        check(
          activationDecisions++ < ctx.config.limits.max_primitives,
          "BUDGET_EXCEEDED",
          "Activation requests made no bounded progress.",
        );
        const requests = activationRequests.splice(0);
        const paths = [
          ...new Set([
            ...Object.keys(ctx.snapshot.manifest),
            ...ctx.store.primitives(ctx.runId).map((p) => p.canonical_path),
          ]),
        ];
        const plan = await invokeRole(
          ctx,
          "activator",
          {
            task: ctx.store.getRun(ctx.runId)!.request.task,
            activation_requests: requests,
            current_primitives: ctx.store
              .primitives(ctx.runId)
              .map((p) => ({ path: p.canonical_path, objective: p.objective })),
            instruction:
              "Resolve these requests; preserve existing ownership. Select only newly implicated or changed assignments.",
          },
          ctx.snapshot.root,
          paths,
        );
        await registerPlan(ctx, plan, false);
        continue;
      }
      if (
        ctx.store.quiescent(
          ctx.runId,
          ctx.generation,
          activationRequests.length,
          running.size,
        )
      )
        return;
      throw new RuntimeError(
        "NO_PROGRESS",
        "The round has unresolved inbox work without a runnable owner.",
      );
    }
  } catch (error) {
    ctx.cancelWorkers(error);
    throw error;
  } finally {
    await Promise.all(running.values());
  }
}
