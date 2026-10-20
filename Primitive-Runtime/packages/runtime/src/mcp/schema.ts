import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolRequest } from "../types.js";
import { RuntimeError } from "../errors.js";
export const actionSchema = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/primitive-runtime-actions.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  actionSchema,
);
export function parseAction(value: unknown): ToolRequest {
  if (!validate(value))
    throw new RuntimeError(
      "INVALID_ARGUMENT",
      "Arguments must match one action schema; unknown fields, unbounded values and empty identifiers are rejected.",
    );
  return value as ToolRequest;
}
