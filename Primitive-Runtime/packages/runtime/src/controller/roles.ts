import { readArtifact } from "../workspace/index.js";
import {
  NativeSession,
  POLICY_REVISION,
  type EngineState,
} from "../engine/native.js";
import { planSchema, diagnosisSchema } from "../models/tools.js";
import type { ActivationPlan, Diagnosis } from "../types.js";
import { RuntimeError, safeError, check } from "../errors.js";
import { identifier } from "../util.js";
import { prompt, assertCurrent, type ExecutionContext } from "./context.js";

export async function retrieval(
  ctx: ExecutionContext,
  root: string,
  paths: string[],
  name: string,
  input: any,
): Promise<unknown> {
  assertCurrent(ctx);
  if (name === "list_files") {
    const p = typeof input.prefix === "string" ? input.prefix : "";
    const files = paths.filter((f) => f.startsWith(p));
    return {
      files: files.slice(0, 200),
      truncated: files.length > 200,
      total: files.length,
      hint: "Narrow prefix to retrieve more files.",
    };
  }
  if (name === "read_file") {
    check(
      paths.includes(input.path),
      "ACCESS_DENIED",
      "Artifact is not in the permitted repository snapshot.",
    );
    return {
      ...(await readArtifact(
        root,
        input.path,
        ctx.config.limits.max_file_bytes,
      )),
      path: input.path,
    };
  }
  if (name === "search") {
    check(
      typeof input.query === "string" &&
        input.query.length > 0 &&
        Buffer.byteLength(input.query) <= 1024,
      "INVALID_ARGUMENT",
      "Search query must contain 1 to 1024 UTF-8 bytes.",
    );
    const selected = input.path ? paths.filter((p) => p === input.path) : paths;
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0,
      bytes = 0;
    for (const path of selected) {
      assertCurrent(ctx);
      if (scanned >= 1000 || bytes >= 2097152 || matches.length >= 80) break;
      scanned++;
      try {
        const file = await readArtifact(
          root,
          path,
          ctx.config.limits.max_file_bytes,
        );
        bytes += Buffer.byteLength(file.content);
        let line = 0;
        for (const text of file.content.split("\n")) {
          line++;
          if (text.includes(input.query)) {
            matches.push({ path, line, text: text.slice(0, 500) });
            if (matches.length >= 80) break;
          }
        }
      } catch (error) {
        if (
          error instanceof RuntimeError &&
          [
            "UNSUPPORTED_ARTIFACT",
            "BINARY_UNSUPPORTED",
            "FILE_TOO_LARGE",
            "BUDGET_EXCEEDED",
          ].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    return {
      matches,
      files_scanned: scanned,
      truncated: scanned < selected.length || matches.length >= 80,
    };
  }
  throw new RuntimeError("ACCESS_DENIED", "Unknown retrieval tool.");
}
export async function invokeRole(
  ctx: ExecutionContext,
  role: "activator",
  input: unknown,
  root?: string,
  paths?: string[],
): Promise<ActivationPlan>;
export async function invokeRole(
  ctx: ExecutionContext,
  role: "diagnosis",
  input: unknown,
  root?: string,
  paths?: string[],
): Promise<Diagnosis>;
export async function invokeRole(
  ctx: ExecutionContext,
  role: "activator" | "diagnosis",
  input: unknown,
  root = ctx.snapshot.root,
  paths = Object.keys(ctx.snapshot.manifest),
): Promise<ActivationPlan | Diagnosis> {
  const session = new NativeSession(
    ctx.config.engine,
    identifier(role),
    {
      run_id: ctx.runId,
      role,
      artifact_path: null,
      allowed_dependencies: paths,
      execution_generation: ctx.generation,
      policy_revision: POLICY_REVISION,
      max_tool_calls: ctx.config.limits.max_tool_calls,
      max_payload_bytes: 16777216,
    },
    ctx.signal,
  );
  const state: EngineState = {
    artifact_hash: null,
    artifact_version: 0,
    inbox_cursor: 0,
  };
  let corrections = 0;
  try {
    await session.initialize(state);
    await session.beginTurn(prompt(role), JSON.stringify(input));
    for (let turn = 0; turn < ctx.config.limits.max_tool_calls; turn++) {
      assertCurrent(ctx);
      const request = await session.requestTurn();
      const completion = await ctx.model.complete(
        role,
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
          "Role must finish using its structured submission tool.",
        );
        await session.correctTurn(
          "Use the provided tools. Finish by calling " +
            (role === "activator" ? "submit_plan" : "submit_diagnosis") +
            " with the required schema.",
        );
        continue;
      }
      for (const call of calls) {
        assertCurrent(ctx);
        let input: any;
        let authorized = false;
        let output: unknown;
        let parsed: ActivationPlan | Diagnosis | undefined;
        let error = false;
        try {
          input = JSON.parse(call.function.arguments);
          await session.authorize(call.id, call.function.name, input);
          authorized = true;
          assertCurrent(ctx);
          if (call.function.name === "submit_plan" && role === "activator") {
            parsed = planSchema.parse(input);
            check(
              parsed.assignments.length <= ctx.config.limits.max_primitives,
              "BUDGET_EXCEEDED",
              "Plan exceeds primitive limit.",
            );
            output = { accepted: true };
          } else if (
            call.function.name === "submit_diagnosis" &&
            role === "diagnosis"
          ) {
            parsed = diagnosisSchema.parse(input);
            output = { accepted: true };
          } else
            output = await retrieval(
              ctx,
              root,
              paths,
              call.function.name,
              input,
            );
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
            "Structured role output correction budget exhausted.",
          );
          error = true;
          output = {
            ok: false,
            error:
              caught instanceof RuntimeError
                ? safeError(caught)
                : {
                    code: "INVALID_ARGUMENT",
                    message: "Arguments must match the advertised JSON schema.",
                  },
          };
        }
        if (authorized) await session.complete(call.id, output, error, state);
        else await session.reject(call.id, output);
        ctx.store.event(ctx.runId, "role_tool", {
          role,
          tool: call.function.name,
          is_error: error,
        });
        if (parsed && !error) {
          check(
            calls.at(-1) === call,
            "MODEL_OUTPUT_INVALID",
            "Submission must be the last tool call in a turn.",
          );
          return parsed;
        }
      }
    }
    throw new RuntimeError("BUDGET_EXCEEDED", "Role tool budget exhausted.");
  } finally {
    await session.close();
  }
}
