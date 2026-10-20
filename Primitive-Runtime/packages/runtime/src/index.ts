export * from "./contracts.js";

/**
 * The runtime is intentionally not started by importing this package.
 * R0 must implement restricted JCode execution before exposing any public MCP tool.
 */
export function assertRuntimeAvailable(): never {
  throw new Error("NOT_IMPLEMENTED: restricted JCode engine, durable controller and sandbox are required before serving MCP");
}
