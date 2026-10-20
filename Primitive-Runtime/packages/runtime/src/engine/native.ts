import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { hash, identifier } from "../util.js";
import { check, RuntimeError } from "../errors.js";
import type { Role, FunctionTool, ChatMessage, ToolCall } from "../types.js";
export const POLICY_REVISION = "primitive-policy/1";
export const ENGINE_PROTOCOL = "primitive-engine/1";
export const TURN_CORE_PROTOCOL = "jcode-turn/1";
export interface EngineState {
  artifact_hash: string | null;
  artifact_version: number;
  inbox_cursor: number;
}
export interface EnginePolicy {
  run_id: string;
  role: Role;
  artifact_path: string | null;
  allowed_dependencies: string[];
  execution_generation: number;
  policy_revision: string;
  max_tool_calls: number;
  max_payload_bytes: number;
}
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
const MAX_FRAME_BYTES = 20 * 1024 * 1024;
export class NativeSession {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private closed = false;
  private acknowledged = false;
  private policyHash = "";
  private catalog: FunctionTool[] = [];
  private exitPromise: Promise<void>;
  constructor(
    readonly engine: { binary: string; sha256: string },
    readonly sessionId: string,
    readonly policy: EnginePolicy,
    readonly signal: AbortSignal,
  ) {
    check(
      hash(readFileSync(engine.binary)) === engine.sha256,
      "ENGINE_MISMATCH",
      "Native engine does not match the operator-pinned hash.",
    );
    check(!signal.aborted, "CANCELLED", "Execution was cancelled.");
    const env: NodeJS.ProcessEnv = {};
    if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
    this.child = spawn(engine.binary, ["primitive"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exitPromise = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    let chunks: Buffer[] = [];
    let frameBytes = 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          check(
            frameBytes + end - start <= MAX_FRAME_BYTES,
            "ENGINE_PROTOCOL_ERROR",
            "Native response is too large.",
          );
          chunks.push(chunk.subarray(start, end));
          frameBytes += end - start;
          if (newline < 0) break;
          const msg = JSON.parse(
            Buffer.concat(chunks, frameBytes).toString("utf8"),
          );
          chunks = [];
          frameBytes = 0;
          const item = this.pending.get(msg.id);
          check(item, "ENGINE_PROTOCOL_ERROR", "Unexpected native response.");
          this.pending.delete(msg.id);
          clearTimeout(item.timer);
          if (msg.ok) item.resolve(msg.result);
          else
            item.reject(
              new RuntimeError(
                msg.error?.code ?? "ENGINE_ERROR",
                msg.error?.message ?? "Native policy rejected an action.",
              ),
            );
          start = newline + 1;
        }
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("Native protocol failure"),
        );
      }
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", () =>
      this.fail(
        new RuntimeError(
          "ENGINE_UNAVAILABLE",
          "Cannot start the pinned native engine.",
        ),
      ),
    );
    this.child.on("close", () =>
      this.fail(
        new RuntimeError("ENGINE_UNAVAILABLE", "Native engine exited."),
      ),
    );
    const abort = () =>
      this.fail(new RuntimeError("CANCELLED", "Execution cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    this.exitPromise.finally(() => signal.removeEventListener("abort", abort));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }
  private request(value: Record<string, unknown>): Promise<any> {
    check(!this.closed, "ENGINE_UNAVAILABLE", "Native session is closed.");
    const id = identifier("engine");
    const body = JSON.stringify({ id, ...value });
    check(
      Buffer.byteLength(body) < MAX_FRAME_BYTES,
      "BUDGET_EXCEEDED",
      "Native request too large.",
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeError(
            "TIMEOUT",
            "Native engine did not acknowledge an operation.",
          ),
        );
        this.fail(new RuntimeError("TIMEOUT", "Native engine timeout."));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(body + "\n", (error) => {
        if (error)
          this.fail(
            new RuntimeError("ENGINE_UNAVAILABLE", "Native input closed."),
          );
      });
    });
  }
  get tools(): FunctionTool[] {
    check(
      this.acknowledged,
      "ENGINE_PROTOCOL_ERROR",
      "Native tool policy has not been acknowledged.",
    );
    return structuredClone(this.catalog);
  }
  async initialize(state: EngineState): Promise<void> {
    const result = await this.request({
      op: "init",
      session_id: this.sessionId,
      policy: this.policy,
      state,
    });
    check(
      result.policy_ack === true &&
        result.engine_protocol === ENGINE_PROTOCOL &&
        result.turn_core_protocol === TURN_CORE_PROTOCOL &&
        result.shared_ordinary_turn_core === true &&
        typeof result.policy_hash === "string" &&
        Array.isArray(result.tools) &&
        result.tools.length > 0 &&
        result.tools.length <= 16,
      "ENGINE_PROTOCOL_ERROR",
      "Native engine did not acknowledge restricted policy.",
    );
    this.catalog = result.tools.map((tool: any) => {
      check(
        typeof tool.name === "string" &&
          typeof tool.description === "string" &&
          tool.input_schema?.type === "object",
        "ENGINE_PROTOCOL_ERROR",
        "Invalid native tool catalog.",
      );
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      };
    });
    this.policyHash = result.policy_hash;
    this.acknowledged = true;
  }
  async authorize(id: string, name: string, input: unknown): Promise<void> {
    check(
      this.acknowledged,
      "ENGINE_PROTOCOL_ERROR",
      "Restricted policy was not acknowledged.",
    );
    const value = await this.request({
      op: "authorize",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      tool_call: { id, name, input },
    });
    check(
      value.authorized === true && value.policy_hash === this.policyHash,
      "ENGINE_PROTOCOL_ERROR",
      "Native policy acknowledgement changed.",
    );
  }
  async beginTurn(
    systemPrompt: string,
    input: string,
    prior?: unknown,
  ): Promise<void> {
    check(
      this.acknowledged,
      "ENGINE_PROTOCOL_ERROR",
      "Restricted policy was not acknowledged.",
    );
    const value = await this.request({
      op: "turn_begin",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      system_prompt: systemPrompt,
      input,
      ...(prior === undefined ? {} : { prior }),
    });
    check(
      value.ready === true,
      "ENGINE_PROTOCOL_ERROR",
      "Native conversation did not initialize.",
    );
  }
  async requestTurn(): Promise<{
    request_id: string;
    messages: ChatMessage[];
  }> {
    const value = await this.request({
      op: "turn_request",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
    });
    check(
      typeof value.request_id === "string" && Array.isArray(value.messages),
      "ENGINE_PROTOCOL_ERROR",
      "Invalid native model request.",
    );
    return { request_id: value.request_id, messages: value.messages };
  }
  async respondTurn(
    requestId: string,
    message: ChatMessage,
    stopReason: string | null,
  ): Promise<ToolCall[]> {
    const value = await this.request({
      op: "turn_response",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      request_id: requestId,
      message,
      stop_reason: stopReason,
    });
    check(
      Array.isArray(value.tool_calls),
      "ENGINE_PROTOCOL_ERROR",
      "Invalid native turn response.",
    );
    return value.tool_calls;
  }
  async correctTurn(content: string): Promise<void> {
    await this.request({
      op: "turn_correction",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      content,
    });
  }
  async reject(id: string, result: unknown): Promise<void> {
    await this.request({
      op: "reject",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      tool_call_id: id,
      result,
    });
  }
  async complete(
    id: string,
    result: unknown,
    isError: boolean,
    state: EngineState,
  ): Promise<void> {
    await this.request({
      op: "complete",
      session_id: this.sessionId,
      execution_generation: this.policy.execution_generation,
      tool_call_id: id,
      result,
      is_error: isError,
      state,
    });
  }
  async snapshot(): Promise<unknown> {
    return this.request({ op: "snapshot", session_id: this.sessionId });
  }
  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await this.request({
          op: "cancel",
          session_id: this.sessionId,
          execution_generation: this.policy.execution_generation,
        });
      } catch {}
      this.fail(new RuntimeError("CANCELLED", "Native session closed."));
    }
    await this.exitPromise;
  }
}
