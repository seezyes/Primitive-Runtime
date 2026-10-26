import { createForm, formRequest, publicValue, SECTIONS } from "./forms.mjs";
import { safeText } from "./core/render.mjs";
import { moveCursor } from "./core/listview.mjs";

export function rowsFor(state) {
  if (state.page === "runs")
    return state.runs.map((run) => ({ ...run, id: run.run_id ?? run.id }));
  const records = state.configuration?.[state.page];
  if (!records || typeof records !== "object") return [];
  return Object.entries(records)
    .map(([id, value]) => ({ ...value, id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function newState() {
  return {
    page: "overview",
    configuration: {},
    versions: {},
    status: {},
    runs: [],
    view: { cursor: 0, offset: 0, rows: 0 },
    modal: null,
    busy: false,
    message: "Connecting to the local service…",
    error: false,
    connected: false,
    lastUpdated: null,
    viewport: 10,
    closed: false,
  };
}
function operationError(result) {
  const error = new Error("The service did not complete the operation.");
  error.code = result?.error?.code ?? "CONTROL_ERROR";
  return error;
}
const safeError = (error) => {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code)
      ? error.code
      : "CONTROL_ERROR";
  if (code === "REVISION_CONFLICT" || code === "CONFIG_CONFLICT")
    return `${code}: configuration changed. Refresh and reopen the editor; your draft is preserved.`;
  // Provider messages can contain URL credentials or authorization text.
  return `${code}: operation was not completed. Check the operator configuration and service diagnostics.`;
};

export class PanelController {
  constructor({ call, onChange = () => {}, onClose = () => {} }) {
    if (typeof call !== "function")
      throw new TypeError("Operator control callback is required.");
    this.call = call;
    this.onChange = onChange;
    this.onClose = onClose;
    this.state = newState();
    this.refreshing = null;
  }
  changed() {
    if (!this.state.closed) this.onChange(this.state);
  }
  async refresh({ quiet = false } = {}) {
    if (this.state.closed || this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const inspection = await this.call({ action: "inspect" });
        if (!inspection?.ok) throw operationError(inspection);
        this.state.configuration = publicValue(inspection.configuration ?? {});
        this.state.versions = publicValue(inspection.versions ?? {});
        this.state.status = publicValue(inspection.status ?? {});
        this.state.connected = true;
        this.state.lastUpdated = new Date().toISOString();
        if (this.state.page === "runs" || this.state.page === "overview") {
          const result = await this.call({ action: "list_runs" });
          if (result?.ok)
            this.state.runs = Array.isArray(result.runs)
              ? publicValue(result.runs)
              : [];
        }
        const length = rowsFor(this.state).length;
        this.state.view.cursor = Math.max(
          0,
          Math.min(this.state.view.cursor, length - 1),
        );
        if (!quiet) {
          this.state.message = "Connected. Configuration and runs are current.";
          this.state.error = false;
        }
      } catch (error) {
        this.state.connected = false;
        this.state.message = safeError(error);
        this.state.error = true;
      } finally {
        this.refreshing = null;
        this.changed();
      }
    })();
    return this.refreshing;
  }
  setPage(id) {
    if (!SECTIONS.some((section) => section.id === id)) return;
    this.state.page = id;
    this.state.view = { cursor: 0, offset: 0, rows: 0 };
    this.state.modal = null;
    this.changed();
  }
  close() {
    this.state.closed = true;
    this.onClose();
  }
  async operation(request, success, { keepForm = false } = {}) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.message = "Waiting for the service…";
    this.state.error = false;
    this.changed();
    try {
      const response = await this.call(request);
      if (!response?.ok) throw operationError(response);
      if (!keepForm) this.state.modal = null;
      await this.refresh({ quiet: true });
      this.state.message = success;
      this.state.error = false;
      return response;
    } catch (error) {
      this.state.message = safeError(error);
      this.state.error = true;
      if (this.state.modal?.kind === "form")
        this.state.modal.form.error = this.state.message;
      return null;
    } finally {
      this.state.busy = false;
      this.changed();
    }
  }
  async save() {
    const modal = this.state.modal;
    if (modal?.kind !== "form" || this.state.busy) return;
    let request;
    try {
      request = formRequest(modal.form);
    } catch (error) {
      modal.form.error = safeText(error.message, 300);
      this.changed();
      return;
    }
    const success =
      request.action === "provision_client"
        ? `Client created. Credential saved to ${safeText(request.output_file, 500)}.`
        : `Saved ${request.id}. New runs use the new revision.`;
    await this.operation(request, success);
  }
  confirm(title, request, success) {
    this.state.modal = { kind: "confirm", title, request, success };
    this.changed();
  }
  async key(key) {
    if (this.state.closed) return;
    if (key.ctrl && key.name === "c") {
      this.close();
      return;
    }
    if (this.state.busy) return;
    const modal = this.state.modal;
    if (modal?.kind === "confirm") {
      if (key.name === "escape" || key.name === "n") this.state.modal = null;
      else if (key.name === "y") {
        const stopped = modal.request.action === "stop";
        const response = await this.operation(modal.request, modal.success);
        if (response && stopped) this.close();
      }
      this.changed();
      return;
    }
    if (modal?.kind === "detail") {
      if (key.name === "escape" || key.name === "return")
        this.state.modal = null;
      else if (key.name === "up") modal.offset = Math.max(0, modal.offset - 1);
      else if (key.name === "down") modal.offset++;
      else if (key.name === "pageup")
        modal.offset = Math.max(0, modal.offset - this.state.viewport);
      else if (key.name === "pagedown") modal.offset += this.state.viewport;
      this.changed();
      return;
    }
    if (modal?.kind === "form") {
      await this.formKey(key, modal.form);
      return;
    }
    if (key.name === "q" || key.name === "escape") {
      this.close();
      return;
    }
    if (key.name === "r") {
      await this.refresh();
      return;
    }
    const page = SECTIONS.find((section) => section.key === key.name);
    if (page) {
      this.setPage(page.id);
      if (page.id === "runs") await this.refresh({ quiet: true });
      return;
    }
    if (key.name === "tab" || key.name === "left" || key.name === "right") {
      const step = key.name === "left" ? -1 : 1;
      const index = SECTIONS.findIndex(
        (section) => section.id === this.state.page,
      );
      this.setPage(
        SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length].id,
      );
      if (this.state.page === "runs") await this.refresh({ quiet: true });
      return;
    }
    const rows = rowsFor(this.state),
      selected = rows[this.state.view.cursor];
    if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
      const delta = {
        up: -1,
        down: 1,
        pageup: -this.state.viewport,
        pagedown: this.state.viewport,
      }[key.name];
      moveCursor(this.state.view, rows.length, this.state.viewport, delta);
    } else if (key.name === "home") this.state.view.cursor = 0;
    else if (key.name === "end")
      this.state.view.cursor = Math.max(0, rows.length - 1);
    else if (
      key.name === "n" &&
      SECTIONS.find((section) => section.id === this.state.page)?.action
    ) {
      this.state.modal = { kind: "form", form: createForm(this.state.page) };
    } else if ((key.name === "e" || key.name === "return") && selected) {
      if (this.state.page === "clients" || this.state.page === "runs")
        this.state.modal = {
          kind: "detail",
          title: selected.id,
          value: selected,
          offset: 0,
        };
      else
        this.state.modal = {
          kind: "form",
          form: createForm(this.state.page, selected.id, selected),
        };
    } else if (
      key.name === "p" &&
      this.state.page === "model_profiles" &&
      selected
    ) {
      const result = await this.operation(
        { action: "probe_model_profile", id: selected.id },
        `Profile probe completed for ${selected.id}.`,
      );
      if (result)
        this.state.modal = {
          kind: "detail",
          title: "Model protocol probe",
          value: publicValue(result),
          offset: 0,
        };
    } else if (key.name === "x" && this.state.page === "clients" && selected) {
      this.confirm(
        `Revoke client ${safeText(selected.id)}? Existing credentials will stop working.`,
        {
          action: "revoke_client",
          id: selected.id,
          expected_revision: selected.revision ?? null,
        },
        `Client ${safeText(selected.id)} revoked.`,
      );
    } else if (key.name === "d" && this.state.page === "service") {
      this.confirm(
        "Drain the service? Accepted runs continue; new starts are rejected.",
        { action: "drain" },
        "Service is draining. Accepted runs continue.",
      );
    } else if (key.name === "s" && this.state.page === "service") {
      this.confirm(
        "Stop the service? Active runs are interrupted and retained for inspection.",
        { action: "stop" },
        "Service stopped.",
      );
    }
    this.changed();
  }
  async formKey(key, form) {
    const current = form.fields[form.index];
    if (key.name === "escape") {
      this.state.modal = null;
      this.changed();
      return;
    }
    if (key.ctrl && key.name === "s") {
      await this.save();
      return;
    }
    if (
      key.name === "tab" ||
      key.name === "down" ||
      key.name === "up" ||
      key.name === "return"
    ) {
      if (key.name === "return" && form.index === form.fields.length - 1) {
        await this.save();
        return;
      }
      const delta = key.name === "up" ? -1 : 1;
      form.index =
        (form.index + delta + form.fields.length) % form.fields.length;
      form.cursor = form.fields[form.index].value.length;
    } else if (!current.readonly) {
      const prefix = current.value.slice(0, form.cursor),
        suffix = current.value.slice(form.cursor);
      if (key.ctrl && key.name === "u") {
        current.value = "";
        form.cursor = 0;
      } else if (key.name === "home") form.cursor = 0;
      else if (key.name === "end") form.cursor = current.value.length;
      else if (key.name === "left")
        form.cursor -= [...prefix].at(-1)?.length ?? 0;
      else if (key.name === "right") form.cursor += [...suffix][0]?.length ?? 0;
      else if (key.name === "backspace") {
        const count = [...prefix].at(-1)?.length ?? 0;
        current.value = prefix.slice(0, prefix.length - count) + suffix;
        form.cursor -= count;
      } else if (key.name === "delete")
        current.value = prefix + suffix.slice([...suffix][0]?.length ?? 0);
      else if (
        !key.ctrl &&
        key.sequence &&
        (key.name === "paste" || !key.sequence.startsWith("\x1b"))
      ) {
        const added = safeText(key.sequence, 16384);
        if (current.value.length + added.length <= 16384) {
          current.value = prefix + added + suffix;
          form.cursor += added.length;
        }
      }
      form.error = "";
    }
    this.changed();
  }
  async mouse(button, x, y, released, hits) {
    if (released || this.state.closed || this.state.busy) return;
    if (button & 64) {
      await this.key({ name: button & 1 ? "down" : "up" });
      return;
    }
    if ((button & 3) !== 0) return;
    const hit = hits.find(
      (item) => y === item.y && x >= item.x && x < item.x + item.width,
    );
    if (!hit) return;
    if (hit.page) {
      this.setPage(hit.page);
      if (hit.page === "runs") await this.refresh({ quiet: true });
    } else if (hit.row != null) {
      this.state.view.cursor = hit.row;
      this.changed();
    } else if (hit.field != null && this.state.modal?.kind === "form") {
      const form = this.state.modal.form;
      form.index = hit.field;
      form.cursor = form.fields[form.index].value.length;
      this.changed();
    } else if (hit.key) await this.key(hit.key);
  }
}
