import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { RunRecord, PrimitiveRecord, MessageRecord } from "../types.js";
import { isTerminal } from "../contracts.js";
import { check } from "../errors.js";
import { privateDirectory, hash, identifier } from "../util.js";

/** Transactions never cross an await. SQLite, not a model transcript, owns lifecycle. */
export class RunStore {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  constructor(readonly directory: string) {
    privateDirectory(directory);
    const path = join(directory, "runtime.sqlite");
    this.db = new DatabaseSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, principal TEXT NOT NULL, binding TEXT NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(principal,binding,request_id)); CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq)); CREATE TABLE IF NOT EXISTS primitives (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,path)); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), recipient TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,seq)); CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS configurations (revision TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS probes (identity TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS inbox ON messages(run_id,recipient,seq); CREATE INDEX IF NOT EXISTS run_events ON events(run_id,seq);",
    );
    this.events.setMaxListeners(1000);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  findRequest(
    principal: string,
    binding: string,
    id: string,
  ): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM runs WHERE principal=? AND binding=? AND request_id=?",
      )
      .get(principal, binding, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  allRuns(): RunRecord[] {
    return (
      this.db.prepare("SELECT data FROM runs ORDER BY rowid DESC").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  insertRun(run: RunRecord): void {
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)")
      .run(
        run.run_id,
        run.principal,
        run.tool_binding,
        run.request.client_request_id,
        run.request.workspace_id,
        JSON.stringify(run),
      );
  }
  saveRun(run: RunRecord): void {
    run.updated_at = new Date().toISOString();
    this.db
      .prepare("UPDATE runs SET data=? WHERE id=?")
      .run(JSON.stringify(run), run.run_id);
  }
  active(id: string, generation: number): RunRecord {
    const run = this.getRun(id);
    check(
      run &&
        !isTerminal(run.state) &&
        !run.cancel_requested &&
        run.generation === generation,
      "STALE_EXECUTION",
      "Execution is no longer current.",
    );
    return run;
  }
  event(runId: string, type: string, payload: unknown): string {
    const seq = Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE run_id=?",
          )
          .get(runId) as { n: number }
      ).n,
    );
    const event = {
      event_id: String(seq),
      type,
      time: new Date().toISOString(),
      payload,
    };
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(runId, seq, JSON.stringify(event));
    queueMicrotask(() => this.events.emit(runId));
    return String(seq);
  }
  eventPage(
    runId: string,
    after = "0",
    limit = 100,
  ): { events: unknown[]; next_event_id: string | null } {
    check(
      /^(0|[1-9][0-9]{0,14})$/.test(after),
      "INVALID_ARGUMENT",
      "Invalid event cursor.",
    );
    const rows = this.db
      .prepare(
        "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(runId, Number(after), limit + 1) as { seq: number; data: string }[];
    const page = rows.slice(0, limit);
    return {
      events: page.map((x) => JSON.parse(x.data)),
      next_event_id: rows.length > limit ? String(page.at(-1)!.seq) : null,
    };
  }
  primitives(runId: string): PrimitiveRecord[] {
    return (
      this.db
        .prepare("SELECT data FROM primitives WHERE run_id=? ORDER BY path")
        .all(runId) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  primitive(id: string): PrimitiveRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM primitives WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  savePrimitive(p: PrimitiveRecord): void {
    this.db
      .prepare(
        "INSERT INTO primitives VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(p.primitive_id, p.run_id, p.canonical_path, JSON.stringify(p));
  }
  inbox(runId: string, recipient: string, after: number): MessageRecord[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM messages WHERE run_id=? AND recipient=? AND seq>? ORDER BY seq",
        )
        .all(runId, recipient, after) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  send(
    runId: string,
    generation: number,
    senderId: string,
    recipientId: string,
    type: string,
    payload: string,
    messageId: string,
  ): MessageRecord {
    return this.transaction(() => {
      const run = this.active(runId, generation);
      const sender = this.primitive(senderId),
        recipient = this.primitive(recipientId);
      check(
        sender?.run_id === runId && recipient?.run_id === runId,
        "ACCESS_DENIED",
        "Messages must stay inside the run.",
      );
      const existing = this.db
        .prepare("SELECT data FROM messages WHERE id=?")
        .get(messageId) as { data: string } | undefined;
      if (existing) return JSON.parse(existing.data);
      const n = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id=?")
            .get(runId) as { n: number }
        ).n,
      );
      check(
        n < run.resolved.limits.max_messages,
        "BUDGET_EXCEEDED",
        "Message budget exhausted.",
      );
      check(
        Buffer.byteLength(payload) <= 16384,
        "BUDGET_EXCEEDED",
        "Message payload is too large.",
      );
      const sequence = n + 1;
      const msg: MessageRecord = {
        message_id: messageId,
        run_id: runId,
        sender_id: senderId,
        recipient_id: recipientId,
        round_index: run.round_index,
        source_artifact_version: sender.artifact_version,
        type,
        payload,
        sequence,
      };
      this.db
        .prepare("INSERT INTO messages VALUES(?,?,?,?,?)")
        .run(messageId, runId, recipientId, sequence, JSON.stringify(msg));
      if (recipient.state === "finished" || recipient.state === "inactive") {
        recipient.state = "runnable";
        recipient.round_index = run.round_index;
        this.savePrimitive(recipient);
      }
      this.event(runId, "message_delivered", {
        message_id: messageId,
        sender_id: senderId,
        recipient_id: recipientId,
        sequence,
      });
      return msg;
    });
  }
  finishPrimitive(
    id: string,
    generation: number,
    version: number,
    cursor: number,
  ): boolean {
    return this.transaction(() => {
      const p = this.primitive(id);
      check(p, "ACCESS_DENIED", "Unknown primitive.");
      this.active(p.run_id, generation);
      check(
        p.execution_generation === generation && p.artifact_version === version,
        "PATCH_CONFLICT",
        "Primitive version changed before completion.",
      );
      const pending = this.inbox(p.run_id, id, cursor);
      if (pending.length || p.inbox_cursor !== cursor) {
        p.state = "runnable";
        this.savePrimitive(p);
        return false;
      }
      p.state = "finished";
      this.savePrimitive(p);
      return true;
    });
  }
  quiescent(
    runId: string,
    generation: number,
    pendingActivations: number,
    running: number,
  ): boolean {
    return this.transaction(() => {
      this.active(runId, generation);
      if (running || pendingActivations) return false;
      return this.primitives(runId).every(
        (p) =>
          p.state !== "running" &&
          p.state !== "runnable" &&
          this.inbox(runId, p.primitive_id, p.inbox_cursor).length === 0,
      );
    });
  }
  artifact(
    runId: string,
    type: string,
    content: string | Uint8Array,
    maxBytes: number,
  ): string {
    const bytes = Buffer.from(content);
    check(
      bytes.length <= maxBytes,
      "BUDGET_EXCEEDED",
      "Artifact size limit exceeded.",
    );
    const id = identifier("artifact");
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(id, runId, type, hash(bytes), bytes);
    return id;
  }
  readArtifact(
    runId: string,
    id: string,
    offset: number,
    maxBytes: number,
  ): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT type,hash,bytes FROM artifacts WHERE id=? AND run_id=?")
      .get(id, runId) as
      | { type: string; hash: string; bytes: Uint8Array }
      | undefined;
    check(row, "ACCESS_DENIED", "Artifact does not belong to this run.");
    const bytes = Buffer.from(row.bytes);
    check(
      offset <= bytes.length,
      "INVALID_ARGUMENT",
      "Artifact offset is outside the content.",
    );
    const end = Math.min(bytes.length, offset + maxBytes);
    return {
      artifact_id: id,
      type: row.type,
      hash: row.hash,
      size_bytes: bytes.length,
      offset,
      encoding: "base64",
      content: bytes.subarray(offset, end).toString("base64"),
      truncated: end < bytes.length,
      next_offset: end < bytes.length ? end : null,
    };
  }
  saveSnapshot(runId: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO snapshots VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data",
      )
      .run(runId, JSON.stringify(value));
  }
  snapshot<T>(runId: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM snapshots WHERE run_id=?")
      .get(runId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveConfiguration(revision: string, value: unknown): void {
    this.db
      .prepare("INSERT OR IGNORE INTO configurations VALUES(?,?)")
      .run(revision, JSON.stringify(value));
  }
  saveProbe(identity: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO probes VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data",
      )
      .run(identity, JSON.stringify(value));
  }
  probe(identity: string): unknown {
    const row = this.db
      .prepare("SELECT data FROM probes WHERE identity=?")
      .get(identity) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  interruptAbandoned(): number {
    let n = 0;
    this.transaction(() => {
      for (const run of this.allRuns())
        if (!isTerminal(run.state)) {
          run.generation++;
          run.state = "interrupted";
          run.phase = null;
          run.finished_at = new Date().toISOString();
          run.error = {
            code: "SERVICE_RESTARTED",
            message:
              "Service restarted; abandoned executions were fenced and were not resumed.",
            retryable: false,
          };
          run.result = {
            unverified_acceptance_criteria:
              run.request.acceptance_criteria ?? [],
            warnings: [run.error.message],
            error: run.error,
          };
          this.saveRun(run);
          this.event(run.run_id, "interrupted", { generation: run.generation });
          n++;
        }
    });
    return n;
  }
  expire(retentionDays: number, eligibleIds?: ReadonlySet<string>): string[] {
    const cutoff = Date.now() - retentionDays * 86400000;
    const ids: string[] = [];
    this.transaction(() => {
      for (const run of this.allRuns())
        if (
          !run.expired &&
          (!eligibleIds || eligibleIds.has(run.run_id)) &&
          isTerminal(run.state) &&
          run.finished_at &&
          Date.parse(run.finished_at) < cutoff
        ) {
          run.expired = true;
          run.result = null;
          run.error = {
            code: "RUN_EXPIRED",
            message:
              "Run artifacts have expired; its idempotency tombstone remains.",
            retryable: false,
          };
          this.saveRun(run);
          for (const table of [
            "artifacts",
            "messages",
            "primitives",
            "snapshots",
            "events",
          ])
            this.db
              .prepare("DELETE FROM " + table + " WHERE run_id=?")
              .run(run.run_id);
          ids.push(run.run_id);
        }
    });
    return ids;
  }
}
