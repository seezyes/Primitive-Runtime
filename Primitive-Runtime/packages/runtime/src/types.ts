import type {
  RunState,
  Phase,
  Verification,
  Application,
} from "./contracts.js";
export type Role = "activator" | "primitive" | "diagnosis";
export interface Limits {
  max_parallel: number;
  max_revisions: number;
  max_wall_time_seconds: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_primitives: number;
  max_messages: number;
  max_file_bytes: number;
  max_workspace_bytes: number;
  max_files: number;
  max_artifact_bytes: number;
  max_tool_calls: number;
  max_model_calls: number;
  max_provider_retries: number;
  max_schema_corrections: number;
  max_cost_usd?: number;
}
export const DEFAULT_LIMITS: Limits = {
  max_parallel: 4,
  max_revisions: 3,
  max_wall_time_seconds: 900,
  max_input_tokens: 200000,
  max_output_tokens: 40000,
  max_primitives: 16,
  max_messages: 150,
  max_file_bytes: 262144,
  max_workspace_bytes: 67108864,
  max_files: 10000,
  max_artifact_bytes: 4194304,
  max_tool_calls: 128,
  max_model_calls: 256,
  max_provider_retries: 2,
  max_schema_corrections: 2,
};
export interface Endpoint {
  revision: string;
  protocol: "openai-chat-completions";
  base_url: string;
  credential_ref?: string;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
}
export interface ModelRoute {
  endpoint_id: string;
  model: string;
}
export interface ModelProfile {
  revision: string;
  activator: ModelRoute;
  primitive: ModelRoute;
  diagnosis: ModelRoute;
}
export interface ValidationProfile {
  revision: string;
  backend: "bwrap" | "docker";
  network: "none";
  image?: string;
  tools?: string[];
  checks: {
    id: string;
    command: string;
    args: string[];
    required: boolean;
    timeout_seconds: number;
  }[];
  limits: {
    memory_mb: number;
    cpu_seconds: number;
    pids: number;
    max_output_bytes: number;
    max_disk_mb: number;
  };
}
export interface WorkspaceBinding {
  revision: string;
  path: string;
  default_model_profile_id?: string;
  default_validation_profile_id?: string;
  limits?: Partial<Limits>;
}
export const ACTIONS = [
  "capabilities",
  "start",
  "status",
  "result",
  "artifact",
  "cancel",
] as const;
export type Action = (typeof ACTIONS)[number];
export interface ClientCredential {
  revision: string;
  token_hash: string;
  principal: string;
  tool_binding: string;
  workspace_ids: string[];
  model_profile_ids: string[];
  validation_profile_ids: string[];
  actions: Action[];
  revoked?: boolean;
}
export interface OperatorConfig {
  config_version: 1;
  revision: string;
  state_dir: string;
  socket_path: string;
  operator_token_hash: string;
  engine: { binary: string; sha256: string };
  retention_days: number;
  limits: Limits;
  workspaces: Record<string, WorkspaceBinding>;
  endpoints: Record<string, Endpoint>;
  model_profiles: Record<string, ModelProfile>;
  validation_profiles: Record<string, ValidationProfile>;
  clients: Record<string, ClientCredential>;
}
export interface Actor {
  client_id: string;
  principal: string;
  tool_binding: string;
  workspace_ids: string[];
  model_profile_ids: string[];
  validation_profile_ids: string[];
  actions: readonly Action[];
}
export interface StartRequest {
  action: "start";
  client_request_id: string;
  workspace_id: string;
  task: string;
  acceptance_criteria?: string[];
  model_profile_id?: string;
  validation_profile_id?: string;
  limits?: Partial<Limits>;
  mode?: "stage";
}
export type ToolRequest =
  | StartRequest
  | { action: "capabilities" }
  | {
      action: "status";
      run_id: string;
      after_event_id?: string;
      wait_ms?: number;
    }
  | { action: "result"; run_id: string }
  | {
      action: "artifact";
      run_id: string;
      artifact_id: string;
      offset?: number;
      max_bytes?: number;
    }
  | { action: "cancel"; run_id: string; reason?: string };
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  cost_usd: number | null;
  cost_source: "operator_prices" | "unknown";
  model_calls: number;
  by_role: Record<
    Role,
    { input_tokens: number; output_tokens: number; calls: number }
  >;
  resolved_models: string[];
  resolved_providers: string[];
}
export function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    cost_usd: null,
    cost_source: "unknown",
    model_calls: 0,
    by_role: {
      activator: { input_tokens: 0, output_tokens: 0, calls: 0 },
      primitive: { input_tokens: 0, output_tokens: 0, calls: 0 },
      diagnosis: { input_tokens: 0, output_tokens: 0, calls: 0 },
    },
    resolved_models: [],
    resolved_providers: [],
  };
}
export interface ResolvedConfig {
  revision: string;
  workspace: WorkspaceBinding;
  model_profile_id: string;
  model_profile: ModelProfile;
  validation_profile_id: string;
  validation_profile: ValidationProfile;
  endpoints: Record<string, Endpoint>;
  limits: Limits;
  engine: { binary: string; sha256: string };
}
export interface RunRecord {
  run_id: string;
  principal: string;
  tool_binding: string;
  client_id: string;
  request_digest: string;
  request: StartRequest;
  resolved: ResolvedConfig;
  state: RunState;
  phase: Phase;
  verification: Verification;
  application: Application;
  generation: number;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  round_index: number;
  usage: Usage;
  result: Record<string, unknown> | null;
  error: { code: string; message: string; retryable: boolean } | null;
  expired?: boolean;
}
export interface PrimitiveRecord {
  primitive_id: string;
  run_id: string;
  artifact_id: string;
  canonical_path: string;
  base_hash: string | null;
  current_hash: string | null;
  artifact_version: number;
  objective: string;
  dependency_ids: string[];
  inbox_cursor: number;
  session_id: string;
  execution_generation: number;
  policy_revision: string;
  state: "runnable" | "running" | "finished" | "inactive";
  round_index: number;
  turns: number;
  tool_calls: number;
  seen_tool_ids: string[];
  native_snapshot?: unknown;
  conversation?: unknown;
}
export interface MessageRecord {
  message_id: string;
  run_id: string;
  sender_id: string;
  recipient_id: string;
  round_index: number;
  source_artifact_version: number;
  type: string;
  payload: string;
  sequence: number;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface Assignment {
  path: string;
  objective: string;
  dependencies: string[];
  create?: boolean;
}
export interface ActivationPlan {
  assignments: Assignment[];
  summary: string;
}
export interface Diagnosis {
  verdict: "pass" | "fail";
  evidence: string[];
  causes: { path: string; reason: string }[];
  guidance: { path: string; objective: string }[];
  summary: string;
}
