import { readFileSync } from "node:fs";
import { CONTRACT_VERSION, MCP_BASELINE } from "./contracts.js";

export const VERSION = "0.1.0";
export const CONTROL_VERSION = "primitive-control/1";

/** The release packager writes this file from the reviewed source and binary. */
function buildMetadata(): Record<string, unknown> | null {
  try {
    const value = JSON.parse(
      readFileSync(
        new URL("../../../build-info.json", import.meta.url),
        "utf8",
      ),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function versions(): Record<string, unknown> {
  const build = buildMetadata();
  return {
    runtime_version: VERSION,
    contract_version: CONTRACT_VERSION,
    control_version: CONTROL_VERSION,
    mcp_versions: [MCP_BASELINE],
    engine_protocol: "primitive-engine/1",
    policy_revision: "primitive-policy/1",
    turn_core_protocol: "jcode-turn/1",
    shared_ordinary_turn_core: true,
    upstream_release: "v0.99.0",
    upstream_commit: "774613c90751b6a26ae9eb6a27be6aff3f210062",
    source_revision: build?.source_revision ?? "unreleased-source",
    modified_engine_revision:
      (build?.engine as Record<string, unknown> | undefined)?.source_revision ??
      "unreleased-source",
    mcp_sdk_version: "1.32.1",
    build,
  };
}
