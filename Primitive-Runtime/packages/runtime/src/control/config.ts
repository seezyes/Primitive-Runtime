import { z } from "zod";
import { isAbsolute, join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACTIONS,
  DEFAULT_LIMITS,
  type OperatorConfig,
  type Actor,
  type Limits,
  type StartRequest,
  type ResolvedConfig,
} from "../types.js";
import {
  atomicJSON,
  readPrivateJSON,
  hash,
  identifier,
  privateDirectory,
} from "../util.js";
import { check, RuntimeError } from "../errors.js";

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const rev = z.string().min(1).max(160);
const path = z
  .string()
  .max(4096)
  .refine(isAbsolute, "An absolute path is required");
const limitsShape = {
  max_parallel: z.number().int().min(1).max(16),
  max_revisions: z.number().int().min(0).max(20),
  max_wall_time_seconds: z.number().int().min(1).max(86400),
  max_input_tokens: z.number().int().min(1).max(100000000),
  max_output_tokens: z.number().int().min(1).max(10000000),
  max_primitives: z.number().int().min(1).max(256),
  max_messages: z.number().int().min(0).max(10000),
  max_file_bytes: z.number().int().min(1).max(1048576),
  max_workspace_bytes: z.number().int().min(1).max(1073741824),
  max_files: z.number().int().min(1).max(100000),
  max_artifact_bytes: z.number().int().min(1).max(16777216),
  max_tool_calls: z.number().int().min(1).max(10000),
  max_model_calls: z.number().int().min(1).max(10000),
  max_provider_retries: z.number().int().min(0).max(5),
  max_schema_corrections: z.number().int().min(0).max(5),
  max_cost_usd: z.number().positive().max(100000).optional(),
};
export const limitsSchema = z.object(limitsShape).strict();
export const endpointSchema = z
  .object({
    revision: rev,
    protocol: z.literal("openai-chat-completions"),
    base_url: z
      .string()
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
        );
      }, "Use HTTPS or loopback HTTP without embedded credentials"),
    credential_ref: z
      .string()
      .max(4096)
      .regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/)
      .optional(),
    input_cost_per_million: z.number().nonnegative().optional(),
    output_cost_per_million: z.number().nonnegative().optional(),
  })
  .strict();
const route = z
  .object({ endpoint_id: id, model: z.string().min(1).max(256) })
  .strict();
export const modelSchema = z
  .object({
    revision: rev,
    activator: route,
    primitive: route,
    diagnosis: route,
  })
  .strict();
export const workspaceSchema = z
  .object({
    revision: rev,
    path,
    default_model_profile_id: id.optional(),
    default_validation_profile_id: id.optional(),
    limits: limitsSchema.partial().optional(),
  })
  .strict();
export const validationSchema = z
  .object({
    revision: rev,
    backend: z.enum(["bwrap", "docker"]),
    network: z.literal("none"),
    image: z.string().max(512).optional(),
    tools: z.array(path).max(16).optional(),
    checks: z
      .array(
        z
          .object({
            id,
            command: z.string().min(1).max(4096),
            args: z.array(z.string().max(4096)).max(100),
            required: z.boolean(),
            timeout_seconds: z.number().int().min(1).max(3600),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    limits: z
      .object({
        memory_mb: z.number().int().min(32).max(32768),
        cpu_seconds: z.number().int().min(1).max(3600),
        pids: z.number().int().min(1).max(512),
        max_output_bytes: z.number().int().min(1024).max(1048576),
        max_disk_mb: z.number().int().min(1).max(16384),
      })
      .strict(),
  })
  .strict()
  .refine(
    (x) => x.checks.some((c) => c.required),
    "At least one required check is necessary",
  )
  .refine(
    (x) => new Set(x.checks.map((c) => c.id)).size === x.checks.length,
    "Check IDs must be unique",
  )
  .refine(
    (x) => x.backend !== "docker" || Boolean(x.image?.includes("@sha256:")),
    "Docker image must be pinned by digest",
  );
const clientSchema = z
  .object({
    revision: rev,
    token_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    principal: id,
    tool_binding: id,
    workspace_ids: z.array(id).max(100),
    model_profile_ids: z.array(id).max(100),
    validation_profile_ids: z.array(id).max(100),
    actions: z.array(z.enum(ACTIONS)).min(1),
    revoked: z.boolean().optional(),
  })
  .strict();
const schema = z
  .object({
    config_version: z.literal(1),
    revision: rev,
    state_dir: path,
    socket_path: z.string().min(1).max(4096),
    operator_token_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    engine: z
      .object({
        binary: path,
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    retention_days: z.number().int().min(1).max(3650),
    limits: limitsSchema,
    workspaces: z.record(id, workspaceSchema),
    endpoints: z.record(id, endpointSchema),
    model_profiles: z.record(id, modelSchema),
    validation_profiles: z.record(id, validationSchema),
    clients: z.record(id, clientSchema),
  })
  .strict();
function parse<T>(s: z.ZodType<T>, value: unknown): T {
  const result = s.safeParse(value);
  if (!result.success)
    throw new RuntimeError(
      "INVALID_ARGUMENT",
      result.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .slice(0, 5)
        .join("; "),
    );
  return result.data;
}
export function narrowLimits(upper: Limits, lower?: Partial<Limits>): Limits {
  const out = { ...upper };
  for (const [key, value] of Object.entries(lower ?? {})) {
    const k = key as keyof Limits;
    check(
      typeof value === "number" && Number.isFinite(value),
      "INVALID_ARGUMENT",
      "Invalid limit.",
    );
    check(
      upper[k] === undefined || value <= upper[k]!,
      "ACCESS_DENIED",
      "Task/workspace limits may only narrow operator limits: " + key,
    );
    (out as unknown as Record<string, number>)[key] = value;
  }
  return parse(limitsSchema, out);
}
export class Configuration {
  private value: OperatorConfig;
  private recoverWriteFailure(
    error: unknown,
    before: OperatorConfig,
    credentialFile?: string,
  ): never {
    // Rename is the commit point. A later fsync failure must not resurrect old
    // permissions in memory or delete a credential whose hash is now saved.
    if (
      error instanceof RuntimeError &&
      error.code === "CONFIG_DURABILITY_UNCONFIRMED"
    )
      throw error;
    this.value = before;
    if (credentialFile)
      try {
        unlinkSync(credentialFile);
      } catch {}
    throw error;
  }
  constructor(readonly file: string) {
    this.value = parse(schema, readPrivateJSON(file)) as OperatorConfig;
    this.validateReferences();
  }
  get current(): OperatorConfig {
    return structuredClone(this.value);
  }
  private validateReferences(): void {
    for (const p of Object.values(this.value.model_profiles))
      for (const role of ["activator", "primitive", "diagnosis"] as const)
        check(
          this.value.endpoints[p[role].endpoint_id],
          "CONFIG_REQUIRED",
          "Model profile references an unknown endpoint.",
        );
    for (const w of Object.values(this.value.workspaces)) {
      narrowLimits(this.value.limits, w.limits);
      if (w.default_model_profile_id)
        check(
          this.value.model_profiles[w.default_model_profile_id],
          "CONFIG_REQUIRED",
          "Unknown default model profile.",
        );
      if (w.default_validation_profile_id)
        check(
          this.value.validation_profiles[w.default_validation_profile_id],
          "CONFIG_REQUIRED",
          "Unknown default validation profile.",
        );
    }
  }
  authenticate(token: string, operator = false): Actor | true {
    const digest = Buffer.from(hash(token));
    const equal = (h: string) =>
      h.length === digest.length && timingSafeEqual(Buffer.from(h), digest);
    if (operator) {
      check(
        equal(this.value.operator_token_hash),
        "ACCESS_DENIED",
        "Operator authentication required.",
      );
      return true;
    }
    for (const [client_id, c] of Object.entries(this.value.clients))
      if (!c.revoked && equal(c.token_hash))
        return {
          client_id,
          principal: c.principal,
          tool_binding: c.tool_binding,
          workspace_ids: c.workspace_ids,
          model_profile_ids: c.model_profile_ids,
          validation_profile_ids: c.validation_profile_ids,
          actions: c.actions,
        };
    throw new RuntimeError(
      "ACCESS_DENIED",
      "Invalid or revoked client credential.",
    );
  }
  resolve(actor: Actor, request: StartRequest): ResolvedConfig {
    const c = this.value;
    check(
      actor.workspace_ids.includes(request.workspace_id),
      "ACCESS_DENIED",
      "Workspace is not available to this client.",
    );
    const w = c.workspaces[request.workspace_id];
    check(w, "CONFIG_REQUIRED", "Workspace is not configured.");
    const mid = request.model_profile_id ?? w.default_model_profile_id,
      vid = request.validation_profile_id ?? w.default_validation_profile_id;
    check(
      mid && vid,
      "CONFIG_REQUIRED",
      "Configure default model and validation profiles or select them explicitly.",
    );
    check(
      actor.model_profile_ids.includes(mid) &&
        actor.validation_profile_ids.includes(vid),
      "ACCESS_DENIED",
      "Profile is not available to this client.",
    );
    const model = c.model_profiles[mid],
      validation = c.validation_profiles[vid];
    check(model && validation, "CONFIG_REQUIRED", "Unknown profile.");
    const endpoints = Object.fromEntries(
      [
        ...new Set([
          model.activator.endpoint_id,
          model.primitive.endpoint_id,
          model.diagnosis.endpoint_id,
        ]),
      ].map((id) => [id, c.endpoints[id]!]),
    );
    const limits = narrowLimits(
      narrowLimits(c.limits, w.limits),
      request.limits,
    );
    if (limits.max_cost_usd !== undefined)
      for (const e of Object.values(endpoints))
        check(
          e.input_cost_per_million !== undefined &&
            e.output_cost_per_million !== undefined,
          "CONFIG_REQUIRED",
          "Strict dollar budgets require reliable prices for every selected endpoint.",
        );
    return structuredClone({
      revision: c.revision,
      workspace: w,
      model_profile_id: mid,
      model_profile: model,
      validation_profile_id: vid,
      validation_profile: validation,
      endpoints,
      limits,
      engine: c.engine,
    });
  }
  upsert(
    kind: "workspace" | "endpoint" | "model_profile" | "validation_profile",
    key: string,
    expected: string | null,
    value: unknown,
  ): Record<string, unknown> {
    parse(id, key);
    const table =
      kind === "workspace"
        ? "workspaces"
        : kind === "endpoint"
          ? "endpoints"
          : kind === "model_profile"
            ? "model_profiles"
            : "validation_profiles";
    const before = this.current;
    const map = this.value[table] as Record<string, { revision: string }>;
    check(
      (map[key]?.revision ?? null) === expected,
      "REVISION_CONFLICT",
      "Configuration changed; refresh before saving.",
    );
    check(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_ARGUMENT",
      "Configuration value must be an object.",
    );
    const s =
      kind === "workspace"
        ? workspaceSchema
        : kind === "endpoint"
          ? endpointSchema
          : kind === "model_profile"
            ? modelSchema
            : validationSchema;
    map[key] = parse(s as z.ZodType<any>, {
      ...value,
      revision: identifier("rev"),
    });
    try {
      this.validateReferences();
      this.value.revision = identifier("config");
      atomicJSON(this.file, this.value);
    } catch (error) {
      this.recoverWriteFailure(error, before);
    }
    return { id: key, revision: map[key]!.revision };
  }
  provision(
    key: string,
    value: unknown,
    outputFile: string,
  ): Record<string, unknown> {
    parse(id, key);
    parse(path, outputFile);
    check(
      !this.value.clients[key],
      "REVISION_CONFLICT",
      "Client already exists; revoke and use a new identifier.",
    );
    check(
      !existsSync(outputFile),
      "REVISION_CONFLICT",
      "Credential output file already exists.",
    );
    check(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_ARGUMENT",
      "Client configuration must be an object.",
    );
    const token = randomBytes(32).toString("base64url");
    const client = parse(clientSchema, {
      ...value,
      revision: identifier("client"),
      token_hash: hash(token),
    });
    for (const id of client.workspace_ids)
      check(
        this.value.workspaces[id],
        "CONFIG_REQUIRED",
        "Unknown client workspace.",
      );
    for (const id of client.model_profile_ids)
      check(
        this.value.model_profiles[id],
        "CONFIG_REQUIRED",
        "Unknown client model profile.",
      );
    for (const id of client.validation_profile_ids)
      check(
        this.value.validation_profiles[id],
        "CONFIG_REQUIRED",
        "Unknown client validation profile.",
      );
    privateDirectory(join(outputFile, ".."));
    writeFileSync(
      outputFile,
      JSON.stringify({ socket_path: this.value.socket_path, token }, null, 2) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    const before = this.current;
    try {
      this.value.clients[key] = client;
      this.value.revision = identifier("config");
      atomicJSON(this.file, this.value);
    } catch (error) {
      this.recoverWriteFailure(error, before, outputFile);
    }
    return { id: key, revision: client.revision, output_file: outputFile };
  }
  revoke(key: string, expected: string | null): void {
    const c = this.value.clients[key];
    check(
      c && c.revision === expected,
      "REVISION_CONFLICT",
      "Client revision changed.",
    );
    const before = this.current;
    try {
      c.revoked = true;
      c.revision = identifier("client");
      this.value.revision = identifier("config");
      atomicJSON(this.file, this.value);
    } catch (error) {
      this.recoverWriteFailure(error, before);
    }
  }
  publicConfiguration(): Record<string, unknown> {
    const c = this.current;
    return {
      revision: c.revision,
      workspaces: c.workspaces,
      endpoints: c.endpoints,
      model_profiles: c.model_profiles,
      validation_profiles: c.validation_profiles,
      clients: Object.fromEntries(
        Object.entries(c.clients).map(([id, { token_hash, ...rest }]) => [
          id,
          rest,
        ]),
      ),
      limits: c.limits,
    };
  }
}
export function createOperatorConfig(
  directory: string,
  binary: string,
): { config_file: string; operator_client_file: string } {
  check(
    isAbsolute(directory) && isAbsolute(binary),
    "INVALID_ARGUMENT",
    "Use absolute state and engine paths.",
  );
  check(
    !existsSync(directory) || readdirSync(directory).length === 0,
    "REVISION_CONFLICT",
    "Initialization requires an empty dedicated state directory.",
  );
  privateDirectory(directory);
  const configFile = join(directory, "operator.json"),
    clientFile = join(directory, "operator-client.json");
  check(
    !existsSync(configFile) && !existsSync(clientFile),
    "REVISION_CONFLICT",
    "Configuration already exists.",
  );
  const token = randomBytes(32).toString("base64url");
  const socket =
    process.platform === "win32"
      ? "\\\\.\\pipe\\primitive-runtime-" + randomBytes(24).toString("hex")
      : join(directory, "runtime.sock");
  const c: OperatorConfig = {
    config_version: 1,
    revision: identifier("config"),
    state_dir: directory,
    socket_path: socket,
    operator_token_hash: hash(token),
    engine: { binary, sha256: hash(readFileSync(binary)) },
    retention_days: 7,
    limits: DEFAULT_LIMITS,
    workspaces: {},
    endpoints: {},
    model_profiles: {},
    validation_profiles: {},
    clients: {},
  };
  atomicJSON(configFile, c);
  atomicJSON(clientFile, { socket_path: socket, token });
  atomicJSON(join(directory, ".primitive-runtime-state.json"), {
    marker_version: 1,
    product: "primitive-runtime",
    state_dir: directory,
    instance_id: identifier("instance"),
    state: "active",
    created_at: new Date().toISOString(),
  });
  return { config_file: configFile, operator_client_file: clientFile };
}
