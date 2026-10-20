import { Configuration } from "./control/config.js";
import { RunStore } from "./storage/store.js";
import { RunController } from "./controller/controller.js";
import { CONTRACT_VERSION, isTerminal } from "./contracts.js";
import {
  emptyUsage,
  type Actor,
  type RunRecord,
  type StartRequest,
} from "./types.js";
import { check, RuntimeError, safeError } from "./errors.js";
import { canonical, hash, identifier } from "./util.js";
import { parseAction } from "./mcp/schema.js";
import { ModelClient } from "./models/client.js";
import { z } from "zod";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { recoverValidationLeases } from "./validation/index.js";
import { versions, CONTROL_VERSION } from "./version.js";
import { inspectEngine } from "./engine/version.js";
import { removeTree } from "./workspace/manifest.js";
export { versions, VERSION, CONTROL_VERSION } from "./version.js";
export function runView(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.run_id,
    state: run.state,
    phase: run.phase,
    verification: run.verification,
    application: run.application,
    terminal: isTerminal(run.state),
    round_index: run.round_index,
    cancel_requested: run.cancel_requested,
  };
}
const controlSchema = z
  .object({
    action: z.enum([
      "inspect",
      "list_runs",
      "inspect_run",
      "upsert_workspace",
      "upsert_endpoint",
      "upsert_model_profile",
      "upsert_validation_profile",
      "provision_client",
      "revoke_client",
      "probe_model_profile",
      "drain",
      "stop",
    ]),
    id: z.string().min(1).max(160).optional(),
    expected_revision: z.string().min(1).max(160).nullable().optional(),
    value: z.record(z.unknown()).optional(),
    output_file: z.string().min(1).max(4096).optional(),
  })
  .strict();
export class RuntimeService {
  readonly store: RunStore;
  readonly controller: RunController;
  onStop?: () => void;
  private initialized = false;
  private maintenanceError: ReturnType<typeof safeError> | null = null;
  private readonly lifecycle = new AbortController();
  private readonly probes = new Map<
    AbortController,
    Promise<Record<string, unknown>>
  >();
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private retaining?: Promise<void>;
  constructor(readonly configuration: Configuration) {
    this.store = new RunStore(configuration.current.state_dir);
    this.controller = new RunController(this.store);
    this.store.saveConfiguration(
      configuration.current.revision,
      configuration.current,
    );
  }
  async initialize(): Promise<void> {
    await recoverValidationLeases(join(this.store.directory, "doctor-leases"));
    for (const run of this.store.allRuns())
      await recoverValidationLeases(
        join(this.store.directory, "runs", run.run_id, "validation-leases"),
      );
    this.store.interruptAbandoned();
    this.initialized = true;
  }
  private authorize(actor: Actor, run: RunRecord | undefined): RunRecord {
    check(
      run &&
        actor.principal === run.principal &&
        actor.tool_binding === run.tool_binding &&
        actor.workspace_ids.includes(run.request.workspace_id) &&
        actor.model_profile_ids.includes(run.resolved.model_profile_id) &&
        actor.validation_profile_ids.includes(
          run.resolved.validation_profile_id,
        ),
      "ACCESS_DENIED",
      "Run is not accessible to this client.",
    );
    check(
      !run.expired,
      "RUN_EXPIRED",
      "Run artifacts expired. Reusing its request ID will not create a new paid run.",
    );
    return run;
  }
  async action(actor: Actor, value: unknown): Promise<Record<string, unknown>> {
    try {
      check(
        this.initialized,
        "SERVICE_UNAVAILABLE",
        "Service recovery is not complete.",
      );
      const req = parseAction(value);
      check(
        actor.actions.includes(req.action),
        "ACCESS_DENIED",
        "Action is not allowed for this client.",
      );
      let payload: Record<string, unknown>;
      if (req.action === "capabilities") {
        const c = this.configuration.current;
        payload = {
          ...versions(),
          capabilities: {
            stage_v1: true,
            approved_apply_v1: false,
            operator_control_v1: true,
            persistent_runs: true,
            remote_workspaces: false,
          },
          workspace_ids: actor.workspace_ids.filter((id) =>
            Boolean(c.workspaces[id]),
          ),
          model_profile_ids: actor.model_profile_ids.filter((id) =>
            Boolean(c.model_profiles[id]),
          ),
          validation_profile_ids: actor.validation_profile_ids.filter((id) =>
            Boolean(c.validation_profiles[id]),
          ),
          actions: actor.actions,
        };
      } else if (req.action === "start") payload = this.start(actor, req);
      else {
        let run = this.authorize(actor, this.store.getRun(req.run_id));
        if (req.action === "cancel") {
          await this.controller.cancel(run.run_id);
          run = this.authorize(actor, this.store.getRun(run.run_id));
          payload = { run: runView(run) };
        } else if (req.action === "status") {
          let page = this.store.eventPage(run.run_id, req.after_event_id);
          if (
            !page.events.length &&
            !isTerminal(run.state) &&
            (req.wait_ms ?? 0) > 0
          ) {
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                this.store.events.off(run.run_id, done);
                resolve();
              };
              const timer = setTimeout(done, Math.min(req.wait_ms ?? 0, 10000));
              this.store.events.once(run.run_id, done);
            });
            run = this.authorize(actor, this.store.getRun(run.run_id));
            page = this.store.eventPage(run.run_id, req.after_event_id);
          }
          payload = {
            run: runView(run),
            ...page,
            poll_after_ms: isTerminal(run.state) ? null : 1500,
          };
        } else if (req.action === "result") {
          check(
            isTerminal(run.state),
            "RUN_NOT_READY",
            "Run is still executing.",
          );
          payload = {
            run: runView(run),
            ...(run.result ?? { error: run.error }),
          };
        } else
          payload = {
            run: runView(run),
            artifact: this.store.readArtifact(
              run.run_id,
              req.artifact_id,
              req.offset ?? 0,
              req.max_bytes ?? 65536,
            ),
          };
      }
      return { contract_version: CONTRACT_VERSION, ok: true, ...payload };
    } catch (error) {
      return {
        contract_version: CONTRACT_VERSION,
        ok: false,
        error: safeError(error),
      };
    }
  }
  private start(actor: Actor, request: StartRequest): Record<string, unknown> {
    // Check idempotency before resolving mutable defaults, and keep tombstones after expiry.
    const digest = hash(canonical(request));
    const existing = this.store.findRequest(
      actor.principal,
      actor.tool_binding,
      request.client_request_id,
    );
    if (existing) {
      check(
        existing.request_digest === digest,
        "IDEMPOTENCY_CONFLICT",
        "Request ID was used with different explicit arguments.",
      );
      this.authorize(actor, existing);
      return {
        run: runView(existing),
        poll_after_ms: isTerminal(existing.state) ? null : 1500,
        idempotent_replay: true,
      };
    }
    check(
      !this.controller.draining,
      "SERVICE_DRAINING",
      "Service is draining; no new runs are admitted.",
    );
    const resolved = this.configuration.resolve(actor, request);
    const workspaceIdentity = (path: string) => {
      const canonical = realpathSync.native(path);
      const stat = statSync(canonical);
      return process.platform === "win32"
        ? canonical.toLowerCase()
        : `${stat.dev}:${stat.ino}`;
    };
    let identity: string;
    try {
      identity = workspaceIdentity(resolved.workspace.path);
    } catch {
      throw new RuntimeError(
        "CONFIG_REQUIRED",
        "The configured workspace directory is unavailable.",
      );
    }
    check(
      !this.store.allRuns().some((r) => {
        if (isTerminal(r.state)) return false;
        if (r.request.workspace_id === request.workspace_id) return true;
        try {
          return workspaceIdentity(r.resolved.workspace.path) === identity;
        } catch {
          return false;
        }
      }),
      "WORKSPACE_BUSY",
      "Only one active run per physical workspace is permitted, including aliased bindings.",
    );
    check(
      this.controller.activeCount < 16,
      "BUDGET_EXCEEDED",
      "Global active run limit reached.",
    );
    const now = new Date().toISOString();
    const run: RunRecord = {
      run_id: identifier("pr_run"),
      principal: actor.principal,
      tool_binding: actor.tool_binding,
      client_id: actor.client_id,
      request_digest: digest,
      request: structuredClone(request),
      resolved,
      state: "queued",
      phase: null,
      verification: "not_run",
      application: "not_applicable",
      generation: 1,
      cancel_requested: false,
      created_at: now,
      updated_at: now,
      finished_at: null,
      round_index: 0,
      usage: emptyUsage(),
      result: null,
      error: null,
    };
    this.store.transaction(() => {
      this.store.insertRun(run);
      this.store.event(run.run_id, "accepted", {
        workspace_id: request.workspace_id,
        configuration_revision: resolved.revision,
      });
    });
    this.controller.launch(run.run_id);
    return { run: runView(run), poll_after_ms: 1500 };
  }
  async control(value: unknown): Promise<Record<string, unknown>> {
    try {
      const parsed = controlSchema.safeParse(value);
      check(
        parsed.success,
        "INVALID_ARGUMENT",
        "Invalid operator control request.",
      );
      const req = parsed.data;
      let result: Record<string, unknown> = {};
      if (req.action === "inspect")
        result = {
          versions: {
            ...versions(),
            engine: await inspectEngine(
              this.configuration.current.engine,
              this.lifecycle.signal,
            ),
          },
          configuration: this.configuration.publicConfiguration(),
          status: {
            active_runs: this.controller.activeCount,
            active_probes: this.probes.size,
            draining: this.controller.draining,
            cleanup_error: this.controller.cleanupError,
            maintenance_error: this.maintenanceError,
          },
        };
      else if (req.action === "list_runs")
        result = {
          runs: this.store
            .allRuns()
            .slice(0, 200)
            .map((r) => ({
              ...runView(r),
              principal: r.principal,
              tool_binding: r.tool_binding,
              client_id: r.client_id,
              workspace_id: r.request.workspace_id,
              created_at: r.created_at,
            })),
        };
      else if (req.action === "inspect_run") {
        check(req.id, "INVALID_ARGUMENT", "Run ID required.");
        const run = this.store.getRun(req.id);
        check(run, "RUN_NOT_FOUND", "Unknown run.");
        result = {
          run: {
            ...runView(run),
            principal: run.principal,
            tool_binding: run.tool_binding,
            client_id: run.client_id,
            resolved_configuration: run.resolved,
            request: run.request,
            error: run.error,
          },
        };
      } else if (req.action.startsWith("upsert_")) {
        check(
          req.id && req.expected_revision !== undefined && req.value,
          "INVALID_ARGUMENT",
          "id, expected_revision and value are required.",
        );
        result = this.configuration.upsert(
          req.action.slice(7) as
            | "workspace"
            | "endpoint"
            | "model_profile"
            | "validation_profile",
          req.id,
          req.expected_revision,
          req.value,
        );
      } else if (req.action === "provision_client") {
        check(
          req.id && req.value && req.output_file,
          "INVALID_ARGUMENT",
          "id, value and output_file are required.",
        );
        result = this.configuration.provision(
          req.id,
          req.value,
          req.output_file,
        );
      } else if (req.action === "revoke_client") {
        check(
          req.id && req.expected_revision !== undefined,
          "INVALID_ARGUMENT",
          "id and expected_revision are required.",
        );
        this.configuration.revoke(req.id, req.expected_revision);
        result = { revoked: true };
      } else if (req.action === "probe_model_profile") {
        check(
          !this.controller.draining,
          "SERVICE_DRAINING",
          "Service is draining; no new model probes are admitted.",
        );
        check(
          this.probes.size < 4,
          "BUDGET_EXCEEDED",
          "Concurrent operator model probe limit reached.",
        );
        const c = this.configuration.current;
        check(req.id, "CONFIG_REQUIRED", "Unknown model profile.");
        const profile = c.model_profiles[req.id];
        check(profile, "CONFIG_REQUIRED", "Unknown model profile.");
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 90000);
        const endpoints = Object.fromEntries(
          [
            ...new Set([
              profile.activator.endpoint_id,
              profile.primitive.endpoint_id,
              profile.diagnosis.endpoint_id,
            ]),
          ].map((id) => [id, c.endpoints[id]!]),
        );
        // Operator probes have an explicit independent bounded allowance and report their usage.
        const config = {
          revision: c.revision,
          workspace: { revision: "probe", path: c.state_dir },
          model_profile_id: req.id,
          model_profile: profile,
          validation_profile_id: "probe",
          validation_profile: Object.values(c.validation_profiles)[0]!,
          endpoints,
          limits: {
            ...c.limits,
            max_model_calls: 12,
            max_input_tokens: 20000,
            max_output_tokens: 16000,
          },
          engine: c.engine,
        };
        const task = (async () => {
          const client = new ModelClient(
            config,
            emptyUsage(),
            abort.signal,
            () => {},
          );
          const probe = await client.probe();
          this.store.saveProbe(client.probeIdentity(), probe);
          return { probe, usage: client.usage };
        })();
        this.probes.set(abort, task);
        try {
          result = await task;
        } finally {
          clearTimeout(timer);
          this.probes.delete(abort);
        }
      } else if (req.action === "drain") {
        this.controller.draining = true;
        result = { draining: true, active_runs: this.controller.activeCount };
      } else if (req.action === "stop") {
        await this.stopExecution();
        result = { stopped: true };
        setTimeout(() => this.onStop?.(), 25);
      }
      if (
        req.action.startsWith("upsert_") ||
        req.action === "provision_client" ||
        req.action === "revoke_client"
      )
        this.store.saveConfiguration(
          this.configuration.current.revision,
          this.configuration.current,
        );
      return { control_version: CONTROL_VERSION, ok: true, ...result };
    } catch (error) {
      const failure = safeError(error);
      if (failure.code === "CONFIG_DURABILITY_UNCONFIRMED") {
        this.controller.draining = true;
        this.maintenanceError = failure;
        try {
          this.store.saveConfiguration(
            this.configuration.current.revision,
            this.configuration.current,
          );
        } catch {}
      }
      return {
        control_version: CONTROL_VERSION,
        ok: false,
        error: failure,
      };
    }
  }
  retention(): Promise<void> {
    if (this.stopping || this.closing) return Promise.resolve();
    if (!this.retaining)
      this.retaining = this.expireArtifacts()
        .catch((error) => {
          this.maintenanceError = safeError(error);
          this.controller.draining = true;
          throw error;
        })
        .finally(() => {
          this.retaining = undefined;
        });
    return this.retaining;
  }
  private async expireArtifacts(): Promise<void> {
    if (this.controller.cleanupError) return;
    const days = this.configuration.current.retention_days;
    const cutoff = Date.now() - days * 86400000;
    const removed = new Set<string>();
    for (const run of this.store.allRuns())
      if (
        isTerminal(run.state) &&
        run.finished_at &&
        Date.parse(run.finished_at) < cutoff
      ) {
        const directory = join(this.store.directory, "runs", run.run_id);
        await recoverValidationLeases(join(directory, "validation-leases"));
        await removeTree(directory);
        removed.add(run.run_id);
      }
    this.store.expire(days, removed);
  }
  private stopExecution(): Promise<void> {
    if (!this.stopping) {
      this.controller.draining = true;
      this.lifecycle.abort();
      for (const abort of this.probes.keys()) abort.abort();
      this.stopping = Promise.all([
        this.controller.stop(true),
        ...[...this.probes.values()].map((probe) => probe.catch(() => {})),
      ]).then(() => {});
    }
    return this.stopping;
  }
  close(): Promise<void> {
    if (!this.closing)
      this.closing = this.stopExecution().then(async () => {
        await this.retaining?.catch(() => {});
        this.store.close();
      });
    return this.closing;
  }
}
