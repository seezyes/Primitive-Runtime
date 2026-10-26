import { C, T, fit, safeText, tailCells } from "./core/render.mjs";
import { ensureCursorVisible, followWindow } from "./core/listview.mjs";
import { displayField, publicValue, SECTIONS } from "./forms.mjs";
import { rowsFor } from "./controller.mjs";

const line = (text, color = C.text) => color + safeText(text) + T.reset;
const revision = (value) =>
  value?.revision ? `rev ${safeText(value.revision, 24)}` : "not configured";
const count = (value) => Object.keys(value ?? {}).length;
const engineSummary = (versions) => {
  const engine = versions.engine;
  if (typeof engine === "string") return engine;
  if (engine && typeof engine === "object") {
    if (!engine.available) return "UNAVAILABLE";
    const version = engine.version ?? {};
    return `${version.name ?? "jcode-primitive"} ${version.version ?? "—"}`;
  }
  return versions.engine_version ?? "not inspected";
};
const maintenance = (state) =>
  state.status.cleanup_error?.code ?? state.status.maintenance_error?.code;
const roleSummary = (value) =>
  ["activator", "primitive", "diagnosis"]
    .map(
      (role) =>
        `${role[0].toUpperCase()}: ${safeText(value?.[role]?.model ?? "—", 80)}`,
    )
    .join("   ");
const summary = (section, value) => {
  if (section === "endpoints")
    return `${value.protocol ?? ""}   ${value.base_url ?? ""}`;
  if (section === "model_profiles") return roleSummary(value);
  if (section === "workspaces") return value.path ?? "";
  if (section === "validation_profiles")
    return `${value.backend ?? ""}   ${(value.checks ?? []).length} checks   network: ${value.network ?? "none"}`;
  if (section === "clients")
    return `${value.revoked ? "REVOKED" : "ACTIVE"}   ${value.principal ?? ""}   ${(value.workspace_ids ?? []).length} workspaces`;
  if (section === "runs")
    return `${value.state ?? ""} / ${value.verification ?? "not_run"}   ${value.workspace_id ?? ""}`;
  return "";
};

function normalContent(state, width, height) {
  const rows = rowsFor(state),
    hits = [];
  const title =
    SECTIONS.find((section) => section.id === state.page)?.label ?? state.page;
  let lines = [line(title.toUpperCase(), C.title), ""];
  if (state.page === "overview") {
    const config = state.configuration;
    const ready =
      count(config.endpoints) &&
      count(config.model_profiles) &&
      count(config.workspaces) &&
      count(config.validation_profiles) &&
      count(config.clients);
    lines.push(
      line(
        !state.connected
          ? "SERVICE UNAVAILABLE"
          : state.status.draining
            ? "DRAINING · accepted runs continue"
            : "SERVICE CONNECTED",
        state.connected && !state.status.draining ? C.ok : C.warn,
      ),
      line(
        `Active runs: ${state.status.active_runs ?? 0}    Model probes: ${state.status.active_probes ?? 0}    Retained: ${state.runs.length}`,
      ),
      "",
      line("CONFIGURATION", C.dim),
      line(
        `Endpoints ${count(config.endpoints)}     Model profiles ${count(config.model_profiles)}`,
      ),
      line(
        `Workspaces ${count(config.workspaces)}    Validation profiles ${count(config.validation_profiles)}`,
      ),
      line(`MCP clients ${count(config.clients)}    ${revision(config)}`),
      "",
      line(
        ready
          ? "Select a section to inspect or change settings."
          : "FIRST RUN · configure in this order",
        C.accent,
      ),
      line("2 Endpoints → 3 Role models → 5 Checks"),
      line("4 Workspace defaults → 6 Scoped MCP client"),
      line("Probe each model profile with [P] before admitting runs.", C.dim),
      "",
      line("STAGED BY DEFAULT", C.purple),
      line("Tasks produce a candidate, diff and validation evidence."),
      line("Your primary project files remain unchanged."),
    );
  } else if (state.page === "service") {
    lines.push(
      line(
        !state.connected
          ? "SERVICE UNAVAILABLE"
          : state.status.draining
            ? "DRAINING"
            : "ACCEPTING RUNS",
        !state.connected || state.status.draining ? C.warn : C.ok,
      ),
      line(
        `Active runs: ${state.status.active_runs ?? 0}    Model probes: ${state.status.active_probes ?? 0}`,
      ),
      ...(maintenance(state)
        ? [line(`Needs attention: ${maintenance(state)}`, C.warn)]
        : []),
      "",
      line(
        `Runtime: ${state.versions.runtime ?? state.versions.runtime_version ?? "—"}`,
      ),
      line(`Engine: ${engineSummary(state.versions)}`),
      line(
        `Contract: ${state.versions.contract ?? state.versions.contract_version ?? "primitive-runtime/0.1"}`,
      ),
      "",
      line("[D] Drain", C.accent),
      line("Reject new starts and probes; allow accepted work to finish."),
      "",
      line("[S] Stop", C.warn),
      line("Stop the service. Unfinished runs remain inspectable."),
      "",
      line("[Q] Close this panel", C.dim),
      line("Closing the panel keeps the service running."),
    );
  } else if (rows.length === 0) {
    lines.push(
      line(
        state.page === "runs"
          ? "No runs have been recorded."
          : "No entries yet.",
        C.dim,
      ),
    );
    if (state.page !== "runs")
      lines.push("", line("Press [N] to create the first entry.", C.accent));
  } else {
    const available = Math.max(1, height - 7);
    const window = ensureCursorVisible(state.view, rows.length, available);
    state.viewport = available;
    lines.push(
      line(
        `${rows.length} entries · ${window.start + 1}–${window.start + window.rows}`,
        C.dim,
      ),
    );
    for (
      let index = window.start;
      index < window.start + window.rows;
      index++
    ) {
      const item = rows[index],
        selected = index === state.view.cursor;
      const text = `${selected ? "›" : " "} ${item.id}   ${summary(state.page, item)}`;
      hits.push({ x: 0, y: lines.length, width, row: index });
      lines.push(
        (selected ? C.accent + T.bold : C.text) +
          fit(safeText(text), width) +
          T.reset,
      );
    }
    const selected = rows[state.view.cursor];
    if (selected && lines.length + 3 < height) {
      lines.push("", line(revision(selected), C.dim));
      if (state.page === "workspaces")
        lines.push(
          line(
            `Defaults: ${selected.default_model_profile_id ?? "explicit model"} / ${selected.default_validation_profile_id ?? "explicit validation"}`,
          ),
        );
      if (state.page === "endpoints")
        lines.push(
          line(
            selected.credential_ref
              ? `Credential: ${selected.credential_ref}`
              : "Credential: none",
            C.dim,
          ),
        );
      if (state.page === "runs")
        lines.push(
          line(
            `Application: ${selected.application ?? "—"}    Owner: ${selected.principal ?? selected.owner ?? "—"}`,
            C.dim,
          ),
        );
    }
  }
  return { lines, hits };
}

function formContent(form, width, height) {
  const name =
    SECTIONS.find((section) => section.id === form.section)?.label ??
    form.section;
  const lines = [line(`${form.editing ? "EDIT" : "NEW"} · ${name}`, C.title)];
  lines.push(
    line(
      form.editing
        ? `Expected revision: ${form.expectedRevision}`
        : "A new immutable configuration revision will be created.",
      C.dim,
    ),
    "",
  );
  const viewport = Math.max(1, Math.floor((height - 7) / 2));
  const window = followWindow(
    form.offset ?? 0,
    form.index,
    form.fields.length,
    viewport,
  );
  form.offset = window.start;
  const hits = [];
  for (let index = window.start; index < window.start + window.rows; index++) {
    const field = form.fields[index],
      active = form.index === index;
    lines.push(
      line(
        `${active ? "›" : " "} ${field.label}${field.readonly ? " (fixed)" : ""}`,
        active ? C.accent : C.dim,
      ),
    );
    let value = displayField(field);
    if (active && !field.readonly) {
      // Show the portion around the insertion point; never split escape sequences.
      const cursor = Math.min(form.cursor, value.length);
      const prefix = value.slice(0, cursor),
        suffix = value.slice(cursor);
      const tail = tailCells(prefix, Math.max(1, width - 5));
      value = `${tail}▏${suffix}`;
    }
    hits.push({ x: 0, y: lines.length, width, field: index });
    lines.push(line(`  ${value || "—"}`, active ? C.text : C.dim));
  }
  lines.push(
    "",
    line(
      form.fields[form.index]?.hint ??
        "Enter the value, then press Tab for the next field.",
      C.dim,
    ),
  );
  if (form.error) lines.push(line(form.error, C.err));
  return { lines, hits };
}

function modalContent(state, width, height) {
  const modal = state.modal;
  if (modal.kind === "form") return formContent(modal.form, width, height);
  if (modal.kind === "confirm")
    return {
      lines: [
        line("CONFIRM OPERATOR ACTION", C.warn),
        "",
        line(modal.title),
        "",
        line("[Y] Confirm    [N] Cancel", C.accent),
      ],
      hits: [],
    };
  const details = JSON.stringify(publicValue(modal.value), null, 2).split("\n");
  modal.offset = Math.max(
    0,
    Math.min(modal.offset, Math.max(0, details.length - height + 3)),
  );
  return {
    lines: [
      line(modal.title, C.title),
      "",
      ...details
        .slice(modal.offset, modal.offset + height - 2)
        .map((item) => line(item)),
    ],
    hits: [],
  };
}

function footer(state) {
  if (state.busy) return "[Ctrl+C] Close panel · service continues";
  if (state.modal?.kind === "form")
    return "[Tab/↑↓] Fields  [Ctrl+S] Save  [Esc] Cancel  [Ctrl+U] Clear";
  if (state.modal?.kind === "confirm") return "[Y] Confirm   [N/Esc] Cancel";
  if (state.modal) return "[↑↓/PgUp/PgDn] Scroll   [Enter/Esc] Back";
  if (state.page === "service")
    return "[D] Drain  [S] Stop  [R] Refresh  [Q] Close";
  if (state.page === "overview")
    return "[1–8/Tab] Sections  [R] Refresh  [Q] Close";
  if (state.page === "runs") return "[Enter] Details  [R] Refresh  [Q] Close";
  if (state.page === "clients")
    return "[N] New  [Enter] Details  [X] Revoke  [R] Refresh  [Q] Close";
  if (state.page === "model_profiles")
    return "[N] New  [Enter] Edit  [P] Probe  [R] Refresh  [Q] Close";
  return "[N] New  [Enter] Edit  [R] Refresh  [Q] Close";
}

/** Pure frame data plus hit regions; no terminal, RPC or filesystem side effects. */
export function renderFrame(state, columns = 100, rows = 30) {
  const width = Math.max(1, Math.trunc(columns) - 1),
    height = Math.max(1, Math.trunc(rows));
  const lines = Array.from({ length: height }, () => " ".repeat(width));
  const hits = [];
  const put = (row, value) => {
    if (row >= 0 && row < height) lines[row] = fit(value, width) + T.reset;
  };
  put(
    0,
    C.title +
      T.bold +
      " PRIMITIVE RUNTIME" +
      T.reset +
      (width >= 60 ? C.dim + "   LOCAL OPERATOR PANEL" + T.reset : ""),
  );
  if (height < 9 || width < 30) {
    put(2, line("Resize terminal to at least 31 × 9.", C.warn));
    put(Math.max(1, height - 2), line("[Q] Close · service continues", C.dim));
    return { lines, hits };
  }
  put(1, line("─".repeat(width), C.frame));
  const sidebar = width >= 83 ? 25 : 0,
    bodyHeight = height - 6,
    contentWidth = width - sidebar - (sidebar ? 2 : 0);
  const content = state.modal
    ? modalContent(state, contentWidth, bodyHeight)
    : normalContent(state, contentWidth, bodyHeight);
  for (let i = 0; i < bodyHeight; i++) {
    let left = "";
    if (sidebar) {
      const entry = SECTIONS[i];
      left = entry
        ? (entry.id === state.page ? C.accent + T.bold : C.dim) +
          `${entry.key}  ${entry.label}` +
          T.reset
        : "";
      if (i === SECTIONS.length + 2)
        left = line(
          state.connected ? "● Connected" : "○ Disconnected",
          state.connected ? C.ok : C.warn,
        );
      if (entry && !state.modal)
        hits.push({ x: 0, y: i + 2, width: sidebar, page: entry.id });
      left = fit(left, sidebar) + C.frame + "│ " + T.reset;
    }
    put(i + 2, left + fit(content.lines[i] ?? "", contentWidth));
  }
  for (const hit of content.hits)
    if (hit.y < bodyHeight)
      hits.push({
        ...hit,
        x: hit.x + (sidebar ? sidebar + 2 : 0),
        y: hit.y + 2,
      });
  put(height - 4, line("─".repeat(width), C.frame));
  put(
    height - 3,
    line(state.busy ? "Working…" : state.message, state.error ? C.err : C.dim),
  );
  put(height - 2, line(footer(state), C.accent));
  if (!sidebar && !state.modal)
    put(
      height - 1,
      line(
        `Sections 1–8 · ${SECTIONS.find((section) => section.id === state.page)?.label}`,
        C.dim,
      ),
    );
  return { lines, hits };
}
