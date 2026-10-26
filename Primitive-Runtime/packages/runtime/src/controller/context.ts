import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Role, ResolvedConfig } from "../types.js";
import type { RunStore } from "../storage/store.js";
import type { ModelClient } from "../models/client.js";
import type { Snapshot } from "../workspace/index.js";
export interface ExecutionContext {
  runId: string;
  generation: number;
  signal: AbortSignal;
  cancelWorkers: (reason: unknown) => void;
  store: RunStore;
  config: ResolvedConfig;
  model: ModelClient;
  snapshot: Snapshot;
}
export function prompt(role: Role): string {
  return readFileSync(
    fileURLToPath(
      new URL("../../../../prompts/" + role + "-v1.md", import.meta.url),
    ),
    "utf8",
  );
}
export function assertCurrent(ctx: ExecutionContext): void {
  ctx.signal.throwIfAborted();
  ctx.store.active(ctx.runId, ctx.generation);
}
