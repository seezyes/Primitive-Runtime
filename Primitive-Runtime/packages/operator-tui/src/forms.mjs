import { safeText } from "./core/render.mjs";

export const SECTIONS = Object.freeze([
  { id: "overview", label: "Overview", key: "1" },
  { id: "endpoints", label: "Endpoints", key: "2", action: "upsert_endpoint" },
  {
    id: "model_profiles",
    label: "Model profiles",
    key: "3",
    action: "upsert_model_profile",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    key: "4",
    action: "upsert_workspace",
  },
  {
    id: "validation_profiles",
    label: "Validation checks",
    key: "5",
    action: "upsert_validation_profile",
  },
  { id: "clients", label: "MCP clients", key: "6", action: "provision_client" },
  { id: "runs", label: "Runs", key: "7" },
  { id: "service", label: "Service", key: "8" },
]);

const ROLES = ["activator", "primitive", "diagnosis"];
const ACTIONS = [
  "capabilities",
  "start",
  "status",
  "result",
  "artifact",
  "cancel",
];
const field = (key, label, value = "", options = {}) => ({
  key,
  label,
  value: String(value ?? ""),
  ...options,
});
const json = (value) => JSON.stringify(value);
const list = (value) => (Array.isArray(value) ? value.join(", ") : "");

export function createForm(section, id = "", current = null) {
  const value = current ?? {};
  const fields = [
    field("id", "ID", id, {
      readonly: Boolean(current),
      hint: "Stable local identifier; no spaces.",
    }),
  ];
  if (section === "endpoints") {
    fields.push(
      field("base_url", "Base URL", value.base_url ?? "", {
        hint: "Example: http://127.0.0.1:20128/v1. No embedded key or URL credentials.",
      }),
      field(
        "credential_ref",
        "Credential reference",
        value.credential_ref ?? "",
        {
          sensitive: true,
          hint: "env:MODEL_API_KEY or file:/absolute/private/key-file. Enter a reference, never the key itself.",
        },
      ),
      field(
        "input_cost_per_million",
        "Input USD / 1M tokens",
        value.input_cost_per_million ?? "",
        { hint: "Optional operator price. Empty means unknown, not free." },
      ),
      field(
        "output_cost_per_million",
        "Output USD / 1M tokens",
        value.output_cost_per_million ?? "",
        { hint: "Optional operator price. Empty means unknown, not free." },
      ),
    );
  } else if (section === "model_profiles") {
    for (const role of ROLES)
      fields.push(
        field(
          `${role}_endpoint`,
          `${role}: endpoint ID`,
          value[role]?.endpoint_id ?? "",
          {
            hint: "Choose an existing endpoint ID. Model routes are explicit for each role.",
          },
        ),
        field(`${role}_model`, `${role}: model ID`, value[role]?.model ?? "", {
          hint: "Exact opaque model or route ID accepted by that endpoint.",
        }),
      );
  } else if (section === "workspaces") {
    fields.push(
      field("path", "Repository path", value.path ?? "", {
        hint: "Absolute local path to a clean Git worktree.",
      }),
      field(
        "default_model_profile_id",
        "Default model profile",
        value.default_model_profile_id ?? "",
        {
          hint: "Existing model profile ID, or empty to require explicit selection.",
        },
      ),
      field(
        "default_validation_profile_id",
        "Default validation",
        value.default_validation_profile_id ?? "",
        {
          hint: "Existing validation profile ID, or empty to require explicit selection.",
        },
      ),
      field("limits", "Workspace limits (JSON)", json(value.limits ?? {}), {
        hint: "Optional JSON object of narrower runtime limits. Empty {} inherits operator limits.",
      }),
    );
  } else if (section === "validation_profiles") {
    fields.push(
      field("backend", "Isolation backend", value.backend ?? "bwrap", {
        hint: "bwrap or docker. Checks always execute in actual OS/container isolation.",
      }),
      field("image", "Docker image", value.image ?? "", {
        hint: "Required for docker; prefer an image pinned by sha256 digest.",
      }),
      field("tools", "Runtime directories (JSON)", json(value.tools ?? []), {
        hint: 'Absolute trusted tool directories mounted read-only; for example ["/opt/node"]. Do not include credentials or personal directories.',
      }),
      field(
        "checks",
        "Checks (JSON array)",
        json(
          value.checks ?? [
            {
              id: "test",
              command: "/usr/bin/node",
              args: ["--test"],
              required: true,
              timeout_seconds: 120,
            },
          ],
        ),
        {
          hint: 'JSON: [{"id":"test","command":"/usr/bin/node","args":["--test"],"required":true,"timeout_seconds":120}]. Commands use argument arrays.',
        },
      ),
      field("memory_mb", "Memory MB", value.limits?.memory_mb ?? 1024),
      field("cpu_seconds", "CPU seconds", value.limits?.cpu_seconds ?? 120),
      field("pids", "Process limit", value.limits?.pids ?? 64),
      field(
        "max_output_bytes",
        "Output bytes",
        value.limits?.max_output_bytes ?? 65536,
      ),
      field("max_disk_mb", "Scratch disk MB", value.limits?.max_disk_mb ?? 512),
    );
  } else if (section === "clients") {
    fields.push(
      field("principal", "Principal", value.principal ?? "", {
        hint: "Operator-assigned owner of this client and its runs.",
      }),
      field(
        "tool_binding",
        "Tool binding",
        value.tool_binding ?? "primitive_runtime",
      ),
      field("workspace_ids", "Workspace IDs", list(value.workspace_ids), {
        hint: "Comma-separated allowlist. Empty grants no workspace access.",
      }),
      field(
        "model_profile_ids",
        "Model profile IDs",
        list(value.model_profile_ids),
        { hint: "Comma-separated allowlist." },
      ),
      field(
        "validation_profile_ids",
        "Validation profile IDs",
        list(value.validation_profile_ids),
        { hint: "Comma-separated allowlist." },
      ),
      field("actions", "Allowed actions", list(value.actions ?? ACTIONS), {
        hint: ACTIONS.join(", "),
      }),
      field("output_file", "Credential output file", "", {
        hint: "New absolute file path. The service writes the credential securely; it is never displayed.",
      }),
    );
  } else throw new Error("This section has no editor.");
  return {
    section,
    fields,
    index: current && fields.length > 1 ? 1 : 0,
    cursor: (current && fields[1] ? fields[1].value : fields[0].value).length,
    expectedRevision: current?.revision ?? null,
    editing: Boolean(current),
    error: "",
  };
}

const bad = (message) => {
  throw new Error(message);
};
const identifier = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  )
    bad(
      `${label}: use 1–160 letters, numbers, '.', '_' or '-'; reserved object names are unavailable.`,
    );
  return value;
};
const bounded = (value, label, max = 1024) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    safeText(value, max + 1) !== value
  )
    bad(`${label}: enter a nonempty value without control characters.`);
  return value;
};
const absolute = (value) =>
  value.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(value) ||
  /^\\\\[^\\]+\\[^\\]+/.test(value);
const credentialReference = (value) =>
  typeof value === "string" &&
  value.length <= 4096 &&
  safeText(value, 4097) === value &&
  (/^env:[a-zA-Z_][a-zA-Z0-9_]{0,159}$/.test(value) ||
    (value.startsWith("file:") && absolute(value.slice(5))));
const ids = (value, label) => {
  const result = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (result.length > 100 || new Set(result).size !== result.length)
    bad(`${label}: use at most 100 distinct IDs.`);
  return result.map((item) => identifier(item, label));
};
const positive = (value, label, max) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    bad(`${label}: enter an integer from 1 to ${max}.`);
  return n;
};

/** Build only documented control arguments; form fields never become generic RPC. */
export function formRequest(form) {
  const f = Object.fromEntries(
    form.fields.map((item) => [item.key, item.value.trim()]),
  );
  const id = identifier(f.id, "ID");
  let value;
  if (form.section === "endpoints") {
    let url;
    try {
      url = new URL(f.base_url);
    } catch {
      bad("Base URL: enter a valid HTTP(S) URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      bad(
        "Base URL must use HTTP(S) without embedded credentials, query or fragment.",
      );
    if (
      url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      bad(
        "Use HTTPS for remote endpoints; plain HTTP is restricted to loopback.",
      );
    if (f.credential_ref && !credentialReference(f.credential_ref))
      bad(
        "Credential reference must be env:VARIABLE_NAME or file:/absolute/path; do not paste a key.",
      );
    value = { protocol: "openai-chat-completions", base_url: f.base_url };
    if (f.credential_ref) value.credential_ref = f.credential_ref;
    for (const key of ["input_cost_per_million", "output_cost_per_million"])
      if (f[key] !== "") {
        const cost = Number(f[key]);
        if (!Number.isFinite(cost) || cost < 0)
          bad(
            "Token prices must be finite nonnegative numbers, or empty for unknown.",
          );
        value[key] = cost;
      }
  } else if (form.section === "model_profiles") {
    value = Object.fromEntries(
      ROLES.map((role) => [
        role,
        {
          endpoint_id: identifier(f[`${role}_endpoint`], `${role} endpoint`),
          model: bounded(f[`${role}_model`], `${role} model`, 256),
        },
      ]),
    );
  } else if (form.section === "workspaces") {
    bounded(f.path, "Repository path", 4096);
    if (!absolute(f.path)) bad("Repository path must be absolute.");
    value = { path: f.path };
    for (const key of [
      "default_model_profile_id",
      "default_validation_profile_id",
    ])
      if (f[key]) value[key] = identifier(f[key], key);
    let limits;
    try {
      limits = JSON.parse(f.limits);
    } catch {
      bad("Workspace limits must be a JSON object.");
    }
    const keys = [
      "max_parallel",
      "max_revisions",
      "max_wall_time_seconds",
      "max_input_tokens",
      "max_output_tokens",
      "max_primitives",
      "max_messages",
      "max_file_bytes",
      "max_workspace_bytes",
      "max_files",
      "max_artifact_bytes",
      "max_tool_calls",
      "max_model_calls",
      "max_provider_retries",
      "max_schema_corrections",
      "max_cost_usd",
    ];
    if (
      !limits ||
      Array.isArray(limits) ||
      typeof limits !== "object" ||
      Object.entries(limits).some(
        ([key, number]) =>
          !keys.includes(key) ||
          typeof number !== "number" ||
          !Number.isFinite(number) ||
          number < 0,
      )
    )
      bad(
        "Workspace limits accept only named, nonnegative numeric runtime limits.",
      );
    if (Object.keys(limits).length) value.limits = limits;
  } else if (form.section === "validation_profiles") {
    if (!["bwrap", "docker"].includes(f.backend))
      bad("Isolation backend must be bwrap or docker.");
    let checks;
    try {
      checks = JSON.parse(f.checks);
    } catch {
      bad("Checks must be a JSON array.");
    }
    if (!Array.isArray(checks) || checks.length < 1 || checks.length > 20)
      bad("Configure 1–20 checks.");
    const seen = new Set();
    checks = checks.map((check) => {
      if (
        !check ||
        typeof check !== "object" ||
        Object.keys(check).some(
          (key) =>
            !["id", "command", "args", "required", "timeout_seconds"].includes(
              key,
            ),
        )
      )
        bad(
          "A check accepts only id, command, args, required and timeout_seconds.",
        );
      identifier(check.id, "Check ID");
      if (seen.has(check.id)) bad("Check IDs must be unique.");
      seen.add(check.id);
      bounded(check.command, "Check executable", 4096);
      if (
        !Array.isArray(check.args) ||
        check.args.length > 100 ||
        check.args.some(
          (arg) =>
            typeof arg !== "string" ||
            arg.length > 4096 ||
            /[\x00-\x1f]/.test(arg),
        )
      )
        bad("Check args must be an array of at most 100 bounded strings.");
      if (typeof check.required !== "boolean")
        bad("Every check must specify required: true or false.");
      return {
        id: check.id,
        command: check.command,
        args: check.args,
        required: check.required,
        timeout_seconds: positive(check.timeout_seconds, "Check timeout", 3600),
      };
    });
    if (!checks.some((check) => check.required))
      bad("At least one mandatory check is required.");
    value = {
      backend: f.backend,
      checks,
      network: "none",
      limits: {
        memory_mb: positive(f.memory_mb, "Memory MB", 32768),
        cpu_seconds: positive(f.cpu_seconds, "CPU seconds", 3600),
        pids: positive(f.pids, "Process limit", 512),
        max_output_bytes: positive(f.max_output_bytes, "Output bytes", 1048576),
        max_disk_mb: positive(f.max_disk_mb, "Scratch disk MB", 16384),
      },
    };
    if (value.limits.memory_mb < 32 || value.limits.max_output_bytes < 1024)
      bad("Memory must be at least 32 MB and output at least 1024 bytes.");
    let tools;
    try {
      tools = JSON.parse(f.tools);
    } catch {
      bad("Runtime directories must be a JSON array.");
    }
    if (
      !Array.isArray(tools) ||
      tools.length > 16 ||
      tools.some(
        (path) =>
          typeof path !== "string" ||
          path.length > 4096 ||
          safeText(path, 4097) !== path ||
          !absolute(path),
      )
    )
      bad("Runtime directories must contain at most 16 absolute paths.");
    if (tools.length) value.tools = [...new Set(tools)];
    if (f.backend === "docker") {
      value.image = bounded(f.image, "Docker image");
      if (!value.image.includes("@sha256:"))
        bad("Docker image must be pinned using @sha256:.");
    }
  } else if (form.section === "clients") {
    const actions = ids(f.actions, "Actions");
    if (
      actions.length === 0 ||
      actions.some((action) => !ACTIONS.includes(action))
    )
      bad("Choose one or more listed MCP actions.");
    if (
      !absolute(f.output_file) ||
      safeText(f.output_file, 4097) !== f.output_file ||
      f.output_file.length > 4096
    )
      bad(
        "Credential output file must be a new absolute path without control characters.",
      );
    value = {
      principal: identifier(f.principal, "Principal"),
      tool_binding: identifier(f.tool_binding, "Tool binding"),
      workspace_ids: ids(f.workspace_ids, "Workspace IDs"),
      model_profile_ids: ids(f.model_profile_ids, "Model profile IDs"),
      validation_profile_ids: ids(
        f.validation_profile_ids,
        "Validation profile IDs",
      ),
      actions,
    };
  } else bad("This section has no control operation.");
  const request = {
    action: SECTIONS.find((section) => section.id === form.section).action,
    id,
    expected_revision: form.expectedRevision,
    value,
  };
  if (form.section === "clients") request.output_file = f.output_file;
  return request;
}

export function displayField(field) {
  if (field.key === "base_url") {
    try {
      const url = new URL(field.value);
      if (url.username || url.password || url.search || url.hash) {
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return safeText(url.toString()) + " [credential/query portion hidden]";
      }
    } catch {
      if (/[?@#]/.test(field.value))
        return "[invalid URL with hidden credential/query portion]";
    }
  }
  if (!field.sensitive) return safeText(field.value, 20000);
  if (credentialReference(field.value)) return field.value;
  return field.value ? "•".repeat(Math.min(40, [...field.value].length)) : "";
}

/** Remove credentials even if a malformed service response contains them. */
export function publicValue(value, depth = 0) {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => publicValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => {
        const tokenCounter =
          /^(?:max_)?(?:input|output|prompt|completion|total|cached)_tokens$/.test(
            key,
          ) &&
          typeof item === "number" &&
          Number.isFinite(item);
        if (
          /(?:token|secret|password|authorization|api.?key|credential)/i.test(
            key,
          ) &&
          key !== "credential_ref" &&
          !tokenCounter
        )
          return [safeText(key), "[redacted]"];
        if (key === "credential_ref")
          return [key, credentialReference(item) ? item : "[redacted]"];
        if (key === "base_url" && typeof item === "string") {
          try {
            const url = new URL(item);
            url.username = "";
            url.password = "";
            url.search = "";
            url.hash = "";
            return [key, url.toString()];
          } catch {
            return [key, "[invalid URL]"];
          }
        }
        return [safeText(key), publicValue(item, depth + 1)];
      }),
  );
}
