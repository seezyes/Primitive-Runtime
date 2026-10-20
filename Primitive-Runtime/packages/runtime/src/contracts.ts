/** Proposed application contract. Not a runnable MCP implementation. */
export const CONTRACT_VERSION = "primitive-runtime/0.1" as const;
export const MCP_BASELINE = "2025-06-18" as const;
export const RUN_STATES = ["queued","running","succeeded","failed","cancelled","interrupted"] as const;
export const PHASES = ["preflight","activating","collaborating","validating","diagnosing","finalizing"] as const;
export const VERIFICATIONS = ["not_run","passed","failed","unverified"] as const;
export const APPLICATIONS = ["not_applicable","staged","applied","conflict","apply_failed"] as const;
export type RunState = typeof RUN_STATES[number];
export type Phase = typeof PHASES[number] | null;
export type Verification = typeof VERIFICATIONS[number];
export type Application = typeof APPLICATIONS[number];
export type RunSnapshot = {
  run_id: string; state: RunState; phase: Phase;
  verification: Verification; application: Application; terminal: boolean;
};
export const terminalStates: ReadonlySet<RunState> = new Set(["succeeded","failed","cancelled","interrupted"]);
export function isTerminal(state: RunState): boolean { return terminalStates.has(state); }
/** A successful run requires actual passing mandatory checks; never infer from model text. */
export function canSucceed(requiredChecks: readonly { status: string }[]): boolean {
  return requiredChecks.length > 0 && requiredChecks.every(check => check.status === "passed");
}
