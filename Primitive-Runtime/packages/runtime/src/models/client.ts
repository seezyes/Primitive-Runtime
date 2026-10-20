import type {
  ResolvedConfig,
  Usage,
  Role,
  ChatMessage,
  FunctionTool,
  ToolCall,
  Endpoint,
} from "../types.js";
import { check, RuntimeError } from "../errors.js";
import { readCredential, sleep, canonical, hash, identifier } from "../util.js";

export interface Completion {
  message: ChatMessage;
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
  model: string;
  provider?: string;
  stopReason: string | null;
}
interface Reservation {
  input: number;
  output: number;
  cost: number;
  role: Role;
  endpoint: Endpoint;
}
interface UsageObservation {
  inputTokens: number | null;
  outputTokens: number | null;
  model?: string;
  provider?: string;
}
interface CompletionOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  timeoutMs?: number;
  onDispatched?: () => void;
}

/** One shared ledger reserves concurrent requests and charges every attempt. */
export class ModelClient {
  private pendingInput = 0;
  private pendingOutput = 0;
  private pendingCost = 0;
  private chargedCost: number;
  private unknownCostSeen: boolean;
  private credentials: Record<string, string | undefined> = {};
  readonly usage: Usage;

  constructor(
    readonly config: ResolvedConfig,
    usage: Usage,
    readonly signal: AbortSignal,
    readonly onUsage: (usage: Usage) => void,
  ) {
    this.usage = structuredClone(usage);
    // Retained runs from the preceding state shape have no provider field.
    this.usage.resolved_providers ??= [];
    this.chargedCost = usage.cost_usd ?? 0;
    this.unknownCostSeen = usage.model_calls > 0 && usage.cost_usd === null;
    for (const [id, endpoint] of Object.entries(config.endpoints))
      this.credentials[id] = readCredential(endpoint.credential_ref);
  }

  private reserve(role: Role, payload: string, output: number): Reservation {
    const endpoint =
      this.config.endpoints[this.config.model_profile[role].endpoint_id]!;
    // UTF-8 bytes deliberately overestimate ordinary byte-tokenized input. A
    // provider reporting more than this reservation is detected on settlement.
    const input = Buffer.byteLength(payload),
      limits = this.config.limits;
    check(!this.signal.aborted, "CANCELLED", "Execution cancelled.");
    check(
      this.usage.model_calls < limits.max_model_calls,
      "BUDGET_EXCEEDED",
      "Model call budget exhausted.",
    );
    check(
      this.usage.input_tokens +
        this.usage.estimated_input_tokens +
        this.pendingInput +
        input <=
        limits.max_input_tokens,
      "BUDGET_EXCEEDED",
      "Input token reservation exceeds the run budget.",
    );
    check(
      this.usage.output_tokens +
        this.usage.estimated_output_tokens +
        this.pendingOutput +
        output <=
        limits.max_output_tokens,
      "BUDGET_EXCEEDED",
      "Output token reservation exceeds the run budget.",
    );
    const known =
      endpoint.input_cost_per_million !== undefined &&
      endpoint.output_cost_per_million !== undefined;
    if (limits.max_cost_usd !== undefined)
      check(
        known && !this.unknownCostSeen,
        "CONFIG_REQUIRED",
        "A strict dollar budget requires known prices for every charged request.",
      );
    const cost =
      (input * (endpoint.input_cost_per_million ?? 0) +
        output * (endpoint.output_cost_per_million ?? 0)) /
      1000000;
    if (limits.max_cost_usd !== undefined)
      check(
        this.chargedCost + this.pendingCost + cost <= limits.max_cost_usd,
        "BUDGET_EXCEEDED",
        "Configured inference budget exhausted.",
      );
    this.pendingInput += input;
    this.pendingOutput += output;
    this.pendingCost += cost;
    this.usage.model_calls++;
    this.usage.by_role[role].calls++;
    this.onUsage(structuredClone(this.usage));
    return { input, output, cost, role, endpoint };
  }

  private settle(reservation: Reservation, result?: UsageObservation): void {
    this.pendingInput -= reservation.input;
    this.pendingOutput -= reservation.output;
    this.pendingCost -= reservation.cost;
    const input = result?.inputTokens ?? reservation.input,
      output = result?.outputTokens ?? reservation.output;
    if (result?.inputTokens != null) {
      this.usage.input_tokens += input;
      this.usage.by_role[reservation.role].input_tokens += input;
    } else this.usage.estimated_input_tokens += input;
    if (result?.outputTokens != null) {
      this.usage.output_tokens += output;
      this.usage.by_role[reservation.role].output_tokens += output;
    } else this.usage.estimated_output_tokens += output;
    // A malformed completion does not erase reported billing. For each absent
    // token count, conservatively charge its reservation instead of zero.
    if (result?.model && !this.usage.resolved_models.includes(result.model))
      this.usage.resolved_models.push(result.model);
    if (
      result?.provider &&
      !this.usage.resolved_providers.includes(result.provider)
    )
      this.usage.resolved_providers.push(result.provider);
    const endpoint = reservation.endpoint;
    const known =
      endpoint.input_cost_per_million !== undefined &&
      endpoint.output_cost_per_million !== undefined;
    if (known)
      this.chargedCost +=
        (input * endpoint.input_cost_per_million! +
          output * endpoint.output_cost_per_million!) /
        1000000;
    else this.unknownCostSeen = true;
    this.usage.cost_usd = this.unknownCostSeen ? null : this.chargedCost;
    this.usage.cost_source = this.unknownCostSeen
      ? "unknown"
      : "operator_prices";
    // Record the full observed overrun before rejecting its model output. No
    // tool call from this completion may reach the execution boundary.
    this.onUsage(structuredClone(this.usage));
    const limits = this.config.limits;
    check(
      input <= reservation.input && output <= reservation.output,
      "BUDGET_EXCEEDED",
      "The endpoint reported usage beyond its reserved request budget.",
    );
    check(
      this.usage.input_tokens +
        this.usage.estimated_input_tokens +
        this.pendingInput <=
        limits.max_input_tokens &&
        this.usage.output_tokens +
          this.usage.estimated_output_tokens +
          this.pendingOutput <=
          limits.max_output_tokens,
      "BUDGET_EXCEEDED",
      "Reported usage exceeded the run token budget.",
    );
    if (limits.max_cost_usd !== undefined)
      check(
        !this.unknownCostSeen &&
          this.chargedCost + this.pendingCost <= limits.max_cost_usd,
        "BUDGET_EXCEEDED",
        "Reported usage exceeded the run dollar budget.",
      );
  }

  private async stopResponse(
    response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  ): Promise<void> {
    if (!response?.body) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (reader ? reader.cancel() : response.body.cancel()).catch(
          () => undefined,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RuntimeError(
                  "CLEANUP_FAILED",
                  "The model response stream did not acknowledge cancellation.",
                ),
              ),
            1500,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async request(
    role: Role,
    payload: string,
    options: CompletionOptions,
    observe: (usage: UsageObservation) => void,
  ): Promise<Completion> {
    const route = this.config.model_profile[role],
      endpoint = this.config.endpoints[route.endpoint_id]!;
    const abort = new AbortController();
    const signals = [this.signal, ...(options.signal ? [options.signal] : [])];
    const listeners = signals.map((signal) => {
      const listener = () => abort.abort(signal.reason);
      if (signal.aborted) listener();
      else signal.addEventListener("abort", listener, { once: true });
      return { signal, listener };
    });
    let timedOut = false,
      response: Response | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      bodyFinished = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        abort.abort();
      },
      Math.max(1, Math.min(90000, options.timeoutMs ?? 90000)),
    );
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const token = this.credentials[route.endpoint_id];
      if (token) headers.authorization = "Bearer " + token;
      const pending = fetch(
        endpoint.base_url.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers,
          body: payload,
          signal: abort.signal,
          redirect: "error",
        },
      );
      options.onDispatched?.();
      response = await pending;
      if (!response.ok)
        throw new RuntimeError(
          "MODEL_ROUTE_UNAVAILABLE",
          "Model endpoint returned HTTP " + response.status + ".",
          response.status === 429 || response.status >= 500,
        );
      reader = response.body?.getReader();
      check(
        reader,
        "MODEL_ROUTE_UNAVAILABLE",
        "Model endpoint returned no body.",
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) {
          bodyFinished = true;
          break;
        }
        size += part.value.length;
        check(
          size <= 1048576,
          "BUDGET_EXCEEDED",
          "Model response size exceeded.",
        );
        chunks.push(part.value);
      }
      let json: any;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new RuntimeError(
          "MODEL_OUTPUT_INVALID",
          "Model endpoint returned invalid JSON.",
        );
      }
      check(
        json && typeof json === "object" && !Array.isArray(json),
        "MODEL_OUTPUT_INVALID",
        "Model endpoint response must be an object.",
      );
      const usage = json.usage;
      const inputTokens =
        Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0
          ? usage.prompt_tokens
          : null;
      const outputTokens =
        Number.isSafeInteger(usage?.completion_tokens) &&
        usage.completion_tokens >= 0
          ? usage.completion_tokens
          : null;
      const model =
        typeof json.model === "string" &&
        json.model.length > 0 &&
        json.model.length <= 256
          ? json.model
          : undefined;
      const provider =
        typeof json.provider === "string" &&
        json.provider.length > 0 &&
        json.provider.length <= 256
          ? json.provider
          : undefined;
      // Capture billing independently of payload or metadata validity. The
      // caller settles this envelope even when no completion can be returned.
      observe({
        inputTokens,
        outputTokens,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
      if (typeof json.model === "string")
        check(
          model !== undefined,
          "MODEL_OUTPUT_INVALID",
          "Endpoint-reported model identifier must contain 1 to 256 characters.",
        );
      if (typeof json.provider === "string")
        check(
          provider !== undefined,
          "MODEL_OUTPUT_INVALID",
          "Endpoint-reported provider identifier must contain 1 to 256 characters.",
        );
      const choice = json.choices?.[0],
        raw = choice?.message;
      check(
        raw && raw.role === "assistant",
        "MODEL_OUTPUT_INVALID",
        "Model did not return an assistant message.",
      );
      check(
        raw.content === null ||
          raw.content === undefined ||
          typeof raw.content === "string",
        "MODEL_OUTPUT_INVALID",
        "Unsupported assistant content format.",
      );
      const stopReason = choice.finish_reason ?? null;
      check(
        stopReason === null ||
          (typeof stopReason === "string" &&
            stopReason.length > 0 &&
            stopReason.length <= 256),
        "MODEL_OUTPUT_INVALID",
        "Model finish reason must be null or a bounded string.",
      );
      const calls: ToolCall[] | undefined = raw.tool_calls;
      check(
        calls === undefined ||
          (Array.isArray(calls) &&
            calls.length <= 16 &&
            calls.every(
              (call: any) =>
                call &&
                typeof call === "object" &&
                !Array.isArray(call) &&
                typeof call.id === "string" &&
                call.id.length > 0 &&
                call.id.length <= 256 &&
                call.type === "function" &&
                typeof call.function?.name === "string" &&
                typeof call.function?.arguments === "string",
            )),
        "MODEL_OUTPUT_INVALID",
        "Invalid model tool calls.",
      );
      return {
        message: {
          role: "assistant",
          content: raw.content ?? null,
          ...(calls ? { tool_calls: calls } : {}),
        },
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        reported: inputTokens !== null && outputTokens !== null,
        model: model ?? route.model,
        stopReason,
        ...(provider !== undefined ? { provider } : {}),
      };
    } catch (error) {
      if (signals.some((signal) => signal.aborted))
        throw new RuntimeError(
          "CANCELLED",
          "Model transport request was cancelled.",
        );
      if (timedOut)
        throw new RuntimeError(
          "TIMEOUT",
          "Model endpoint exceeded its request timeout.",
          true,
        );
      if (error instanceof RuntimeError) throw error;
      if (error instanceof TypeError)
        throw new RuntimeError(
          "MODEL_ROUTE_UNAVAILABLE",
          "Model endpoint transport failed.",
          true,
        );
      throw new RuntimeError(
        "MODEL_ROUTE_UNAVAILABLE",
        "Model endpoint response could not be read.",
        false,
      );
    } finally {
      clearTimeout(timeout);
      for (const { signal, listener } of listeners)
        signal.removeEventListener("abort", listener);
      if (!bodyFinished) {
        abort.abort();
        try {
          await this.stopResponse(response, reader);
        } finally {
          reader?.releaseLock();
        }
      } else reader?.releaseLock();
    }
  }

  async complete(
    role: Role,
    messages: ChatMessage[],
    tools: FunctionTool[],
    forceTool?: string,
    options: CompletionOptions = {},
  ): Promise<Completion> {
    let last: unknown;
    for (
      let attempt = 0;
      attempt <= this.config.limits.max_provider_retries;
      attempt++
    ) {
      check(
        !options.signal?.aborted,
        "CANCELLED",
        "Model transport request was cancelled.",
      );
      const remaining =
        this.config.limits.max_output_tokens -
        this.usage.output_tokens -
        this.usage.estimated_output_tokens -
        this.pendingOutput;
      const output = Math.min(4096, options.maxOutputTokens ?? 4096, remaining);
      check(
        Number.isSafeInteger(output) && output > 0,
        "BUDGET_EXCEEDED",
        "Output token budget exhausted.",
      );
      const body = {
        model: this.config.model_profile[role].model,
        messages,
        ...(tools.length
          ? {
              tools,
              tool_choice: forceTool
                ? { type: "function", function: { name: forceTool } }
                : "auto",
              parallel_tool_calls: false,
            }
          : {}),
        max_tokens: output,
        stream: false,
      };
      const payload = JSON.stringify(body),
        reservation = this.reserve(role, payload, output);
      let observed: UsageObservation | undefined;
      try {
        return await this.request(role, payload, options, (usage) => {
          observed = usage;
        });
      } catch (error) {
        last = error;
        if (
          !(error instanceof RuntimeError) ||
          !error.retryable ||
          attempt === this.config.limits.max_provider_retries
        )
          throw error;
      } finally {
        this.settle(reservation, observed);
      }
      await sleep(
        Math.min(2000, 250 * 2 ** attempt),
        options.signal
          ? AbortSignal.any([this.signal, options.signal])
          : this.signal,
      );
    }
    throw last;
  }

  probeIdentity(): string {
    return hash(
      canonical({
        profile: this.config.model_profile,
        endpoints: this.config.endpoints,
      }),
    );
  }

  private async probeCancellation(role: Role): Promise<string> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A one-token request bounds this extra compatibility check. Observing a
      // local transport abort cannot prove remote inference or billing stopped.
      await this.complete(
        role,
        [{ role: "user", content: "Reply OK." }],
        [],
        undefined,
        {
          signal: abort.signal,
          maxOutputTokens: 1,
          timeoutMs: 1500,
          onDispatched: () => {
            timer = setTimeout(() => abort.abort(), 40);
          },
        },
      );
      return "completed_before_abort";
    } catch (error) {
      if (
        abort.signal.aborted &&
        !this.signal.aborted &&
        error instanceof RuntimeError &&
        error.code === "CANCELLED"
      )
        return "transport_abort_observed";
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }

  async probe(): Promise<Record<string, unknown>> {
    const seen = new Set<string>(),
      checks: unknown[] = [];
    const tool: FunctionTool = {
      type: "function",
      function: {
        name: "capability_probe",
        description: "Compatibility test. Echo the nonce unchanged.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
        },
      },
    };
    for (const role of ["activator", "primitive", "diagnosis"] as const) {
      const route = this.config.model_profile[role],
        key = canonical([route.endpoint_id, route.model]);
      if (seen.has(key)) continue;
      seen.add(key);
      const nonce = identifier("probe");
      const messages: ChatMessage[] = [
        {
          role: "user",
          content:
            "Call capability_probe with this nonce: " +
            nonce +
            ". This is a protocol capability test.",
        },
      ];
      const first = await this.complete(
        role,
        messages,
        [tool],
        "capability_probe",
        { maxOutputTokens: 256 },
      );
      const call = first.message.tool_calls?.[0];
      check(
        first.reported &&
          first.message.tool_calls?.length === 1 &&
          call?.function.name === "capability_probe",
        "MODEL_ROUTE_UNAVAILABLE",
        "Model route must support exactly one forced tool call and report usage.",
      );
      let args: any;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new RuntimeError(
          "MODEL_ROUTE_UNAVAILABLE",
          "Model returned malformed tool arguments during compatibility probe.",
        );
      }
      check(
        args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          Object.keys(args).length === 1 &&
          args.nonce === nonce,
        "MODEL_ROUTE_UNAVAILABLE",
        "Model route did not preserve the nonce tool argument.",
      );
      const acknowledgement = identifier("ack");
      const second = await this.complete(
        role,
        [
          ...messages,
          first.message,
          {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true, acknowledgement }),
          },
          {
            role: "user",
            content:
              "Reply with only the acknowledgement value from the tool result, without quotes or another tool call.",
          },
        ],
        [tool],
        undefined,
        { maxOutputTokens: 64 },
      );
      check(
        second.reported &&
          !second.message.tool_calls?.length &&
          second.message.content?.trim() === acknowledgement,
        "MODEL_ROUTE_UNAVAILABLE",
        "Model route did not acknowledge the actual tool result with usage reporting.",
      );
      const cancellation = await this.probeCancellation(role);
      checks.push({
        role,
        requested_model: route.model,
        resolved_model: first.model,
        tool_calls: true,
        tool_results: true,
        usage: true,
        transport_cancellation: cancellation,
        provider_work_cancellation: "unverified",
      });
    }
    return {
      identity: this.probeIdentity(),
      checked_at: new Date().toISOString(),
      checks,
    };
  }
}
