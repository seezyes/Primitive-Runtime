import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { RunStore } from "../storage/store.js";
import type { RunRecord, Diagnosis } from "../types.js";
import { isTerminal, canSucceed } from "../contracts.js";
import { RuntimeError, check, safeError } from "../errors.js";
import {
  createSnapshot,
  freezeCandidate,
  assertWorkspaceUnchanged,
} from "../workspace/index.js";
import { probeSandbox, validateCandidate } from "../validation/index.js";
import { ModelClient } from "../models/client.js";
import { registerPlan, collaborate } from "../primitives/scheduler.js";
import { invokeRole } from "./roles.js";
import type { ExecutionContext } from "./context.js";
import { hash, canonical } from "../util.js";
import { inspectEngine } from "../engine/version.js";

export class RunController {
  private jobs = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  draining = false;
  cleanupError: ReturnType<typeof safeError> | null = null;
  constructor(readonly store: RunStore) {}
  get activeCount(): number {
    return this.jobs.size;
  }
  launch(runId: string): void {
    check(!this.jobs.has(runId), "INTERNAL_ERROR", "Run already has a worker.");
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(runId, abort))
      .finally(() => this.jobs.delete(runId));
    this.jobs.set(runId, { abort, promise });
  }
  async cancel(runId: string): Promise<void> {
    this.store.transaction(() => {
      const run = this.store.getRun(runId);
      check(run, "RUN_NOT_FOUND", "Run does not exist.");
      if (isTerminal(run.state) || run.cancel_requested) return;
      run.cancel_requested = true;
      run.generation++;
      this.store.saveRun(run);
      this.store.event(runId, "cancel_requested", {
        generation: run.generation,
      });
    });
    const job = this.jobs.get(runId);
    if (job) {
      job.abort.abort(new RuntimeError("CANCELLED", "Cancellation requested."));
      await job.promise;
    } else {
      const run = this.store.getRun(runId)!;
      if (!isTerminal(run.state)) {
        run.state = "interrupted";
        run.phase = null;
        run.finished_at = new Date().toISOString();
        run.error = {
          code: "CLEANUP_UNCONFIRMED",
          message: "No worker was available to acknowledge cleanup.",
          retryable: false,
        };
        this.cleanupError = run.error;
        this.draining = true;
        this.store.saveRun(run);
      }
    }
  }
  async stop(cancel = true): Promise<void> {
    this.draining = true;
    if (cancel)
      await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
    else await Promise.all([...this.jobs.values()].map((j) => j.promise));
  }
  private phase(
    runId: string,
    generation: number,
    phase: RunRecord["phase"],
  ): void {
    const run = this.store.active(runId, generation);
    run.state = "running";
    run.phase = phase;
    this.store.saveRun(run);
    this.store.event(runId, "phase_changed", {
      phase,
      round_index: run.round_index,
    });
  }
  private async execute(runId: string, abort: AbortController): Promise<void> {
    const initial = this.store.getRun(runId)!;
    const generation = initial.generation;
    const cfg = initial.resolved;
    const directory = join(this.store.directory, "runs", runId);
    let timer: NodeJS.Timeout | undefined;
    let candidateInfo: Record<string, unknown> | undefined;
    let validationInfo: unknown[] = [];
    let diagnosis: Diagnosis | undefined;
    try {
      timer = setTimeout(
        () =>
          abort.abort(
            new RuntimeError("TIMEOUT", "Run wall-time budget exhausted."),
          ),
        cfg.limits.max_wall_time_seconds * 1000,
      );
      this.phase(runId, generation, "preflight");
      const engine = await inspectEngine(cfg.engine, abort.signal);
      check(
        engine.available,
        "ENGINE_UNAVAILABLE",
        engine.error ?? "The pinned native engine is unavailable.",
      );
      this.store.event(runId, "engine_verified", engine);
      const sandbox = await probeSandbox(cfg.validation_profile, abort.signal, {
        lease_dir: join(directory, "validation-leases"),
      });
      check(
        sandbox.available,
        "UNSUPPORTED_SANDBOX",
        sandbox.reason ?? "The selected isolation backend is unavailable.",
      );
      this.store.active(runId, generation);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const snapshot = await createSnapshot(
        cfg.workspace.path,
        join(directory, "stage"),
        {
          max_file_bytes: cfg.limits.max_file_bytes,
          max_workspace_bytes: cfg.limits.max_workspace_bytes,
          max_files: cfg.limits.max_files,
        },
        abort.signal,
      );
      this.store.active(runId, generation);
      this.store.saveSnapshot(runId, snapshot);
      const model = new ModelClient(
        cfg,
        initial.usage,
        abort.signal,
        (usage) => {
          const run = this.store.getRun(runId);
          if (run) {
            run.usage = structuredClone(usage);
            this.store.saveRun(run);
          }
        },
      );
      const probeId = model.probeIdentity();
      if (!this.store.probe(probeId)) {
        const result = await model.probe();
        this.store.saveProbe(probeId, result);
        this.store.event(runId, "model_profile_verified", {
          identity: probeId,
        });
      }
      const ctx: ExecutionContext = {
        runId,
        generation,
        signal: abort.signal,
        cancelWorkers: (reason) => abort.abort(reason),
        store: this.store,
        config: cfg,
        model,
        snapshot,
      };
      this.phase(runId, generation, "activating");
      let plan = await invokeRole(ctx, "activator", {
        task: initial.request.task,
        acceptance_criteria: initial.request.acceptance_criteria ?? [],
        repository_files: Object.keys(snapshot.manifest).slice(0, 200),
        repository_file_count: Object.keys(snapshot.manifest).length,
        instruction:
          "Use retrieval to inspect relevant components before submitting a plan.",
      });
      for (let round = 0; round <= cfg.limits.max_revisions; round++) {
        const run = this.store.active(runId, generation);
        run.round_index = round;
        this.store.saveRun(run);
        await registerPlan(ctx, plan);
        this.phase(runId, generation, "collaborating");
        await collaborate(ctx);
        this.phase(runId, generation, "validating");
        await assertWorkspaceUnchanged(snapshot);
        this.store.active(runId, generation);
        const candidate = await freezeCandidate(
          snapshot,
          join(directory, "candidate-" + round),
        );
        this.store.active(runId, generation);
        const diffId = this.store.artifact(
          runId,
          "text/x-diff",
          candidate.diff,
          cfg.limits.max_artifact_bytes,
        );
        const manifestId = this.store.artifact(
          runId,
          "application/json",
          JSON.stringify(candidate.manifest),
          cfg.limits.max_artifact_bytes,
        );
        candidateInfo = {
          candidate_id: "candidate_" + round,
          candidate_hash: candidate.hash,
          baseline_id: snapshot.baseline_id,
          files_changed: candidate.files_changed,
          diff_artifact_id: diffId,
          manifest_artifact_id: manifestId,
        };
        const report = await validateCandidate(
          candidate.root,
          candidate.hash,
          cfg.validation_profile,
          abort.signal,
          { lease_dir: join(directory, "validation-leases") },
        );
        this.store.active(runId, generation);
        validationInfo = report.checks.map((c) => {
          const { output, ...metadata } = c;
          return {
            ...metadata,
            output_artifact_id: this.store.artifact(
              runId,
              "text/plain",
              output,
              cfg.limits.max_artifact_bytes,
            ),
          };
        });
        if (
          report.infrastructure_error ||
          report.verification === "unverified"
        ) {
          const r = this.store.getRun(runId)!;
          r.verification = "unverified";
          this.store.saveRun(r);
          throw new RuntimeError(
            report.infrastructure_error?.code ?? "VALIDATION_UNAVAILABLE",
            report.infrastructure_error?.message ??
              "Mandatory validation could not be completed.",
          );
        }
        const checked = this.store.getRun(runId)!;
        checked.verification = report.verification;
        checked.application = "staged";
        this.store.saveRun(checked);
        this.phase(runId, generation, "diagnosing");
        diagnosis = await invokeRole(
          ctx,
          "diagnosis",
          {
            task: initial.request.task,
            acceptance_criteria: initial.request.acceptance_criteria ?? [],
            plan,
            candidate_hash: candidate.hash,
            files_changed: candidate.files_changed,
            checks: report.checks,
            validation_profile_hash: hash(canonical(cfg.validation_profile)),
            instruction:
              "Deterministic failing checks cannot be overridden. Diagnose only this exact candidate.",
          },
          candidate.root,
          Object.keys(candidate.manifest),
        );
        const mandatory = report.checks.filter((c) => c.required);
        if (canSucceed(mandatory) && diagnosis.verdict === "pass") {
          await assertWorkspaceUnchanged(snapshot);
          const done = this.store.active(runId, generation);
          done.state = "succeeded";
          done.phase = null;
          done.verification = "passed";
          done.application = "staged";
          done.finished_at = new Date().toISOString();
          done.result = this.result(
            done,
            candidateInfo,
            validationInfo,
            diagnosis,
          );
          this.store.saveRun(done);
          this.store.event(runId, "completed", {
            state: done.state,
            verification: done.verification,
            candidate_hash: candidate.hash,
          });
          return;
        }
        if (round === cfg.limits.max_revisions)
          throw new RuntimeError(
            "REVISION_BUDGET_EXHAUSTED",
            "Initial candidate and all permitted repair rounds completed without acceptance.",
          );
        this.phase(runId, generation, "activating");
        plan = await invokeRole(
          ctx,
          "activator",
          {
            task: initial.request.task,
            acceptance_criteria: initial.request.acceptance_criteria ?? [],
            previous_plan: plan,
            diagnosis,
            deterministic_verification: report.verification,
            checks: report.checks,
            instruction:
              "Revise only artifacts implicated by execution evidence. A diagnostic PASS does not override failed checks. Preserve prior correct edits.",
          },
          snapshot.root,
          [
            ...new Set([
              ...Object.keys(snapshot.manifest),
              ...this.store.primitives(runId).map((p) => p.canonical_path),
            ]),
          ],
        );
      }
    } catch (caught) {
      abort.abort(caught);
      const run = this.store.getRun(runId)!;
      const cancellation = run.cancel_requested;
      const error = safeError(
        abort.signal.reason instanceof RuntimeError
          ? abort.signal.reason
          : caught,
      );
      const cleanupFailure = ["CLEANUP_FAILED", "CLEANUP_UNCONFIRMED"].includes(
        safeError(caught).code,
      );
      if (cleanupFailure) {
        this.draining = true;
        this.cleanupError = safeError(caught);
      }
      run.state = cancellation && !cleanupFailure ? "cancelled" : "failed";
      run.phase = null;
      run.finished_at = new Date().toISOString();
      run.error = cleanupFailure
        ? safeError(caught)
        : cancellation
          ? {
              code: "CANCELLED",
              message:
                "Cancellation completed; local native/model/sandbox workers have stopped. Provider-side billing after transport cancellation is not verifiable.",
              retryable: false,
            }
          : error;
      if (
        error.code === "WORKSPACE_CONFLICT" ||
        error.code === "SNAPSHOT_CONFLICT" ||
        error.code === "WORKSPACE_DIRTY"
      )
        run.application = "conflict";
      else if (candidateInfo) run.application = "staged";
      if (
        [
          "UNSUPPORTED_SANDBOX",
          "VALIDATION_UNAVAILABLE",
          "CONFIG_REQUIRED",
          "ENGINE_UNAVAILABLE",
          "MODEL_ROUTE_UNAVAILABLE",
        ].includes(error.code) &&
        run.verification !== "failed"
      )
        run.verification = "unverified";
      run.result = this.result(run, candidateInfo, validationInfo, diagnosis);
      this.store.saveRun(run);
      this.store.event(runId, "completed", {
        state: run.state,
        error: run.error,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private result(
    run: RunRecord,
    candidate: Record<string, unknown> | undefined,
    validation: unknown[],
    diagnosis?: Diagnosis,
  ): Record<string, unknown> {
    const files = (candidate?.files_changed ?? []) as string[];
    const tests = files.filter((p) =>
      /(^|\/)(__tests__|tests?|specs?)(\/|\.)|\.(test|spec)\./i.test(p),
    );
    return {
      candidate: candidate ?? null,
      validation,
      diagnosis: diagnosis ?? null,
      validation_profile_hash: hash(canonical(run.resolved.validation_profile)),
      unverified_acceptance_criteria: run.request.acceptance_criteria ?? [],
      rounds_used: candidate ? run.round_index + 1 : 0,
      usage: run.usage,
      apply_requires_operator_approval: true,
      test_files_changed: tests,
      warnings: [
        ...(tests.length
          ? ["Agent-edited tests are not independent proof of correctness."]
          : []),
        ...(run.usage.cost_usd === null
          ? ["Inference pricing is unknown; unknown cost is not zero."]
          : []),
      ],
      error: run.error,
    };
  }
}
