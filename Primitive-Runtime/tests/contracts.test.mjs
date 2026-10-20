import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseAction } from "../dist/runtime/src/mcp/schema.js";
import { CONTRACT_VERSION } from "../dist/runtime/src/contracts.js";
const read = (p) =>
  JSON.parse(readFileSync(new URL("../" + p, import.meta.url), "utf8"));
test("action schema has exactly six actions", () => {
  const s = read("contracts/primitive-runtime-actions.schema.json");
  assert.deepEqual(s.oneOf.map((x) => x.$ref.split("/").pop()).sort(), [
    "artifact",
    "cancel",
    "capabilities",
    "result",
    "start",
    "status",
  ]);
  for (const action of Object.values(s.$defs).filter(
    (x) => x.type === "object" && x.properties?.action,
  ))
    assert.equal(action.additionalProperties, false);
});
test("MVP start cannot request automatic application", () => {
  const s = read("contracts/primitive-runtime-actions.schema.json");
  assert.equal(s.$defs.start.properties.mode.const, "stage");
  assert.equal(s.$defs.status.properties.wait_ms.maximum, 10000);
});
test("run-state contract enumerates independent dimensions", () => {
  const s = read("contracts/state-v0.1.schema.json");
  assert.ok(s.properties.verification.enum.includes("unverified"));
  assert.ok(s.properties.application.enum.includes("staged"));
});

test("shipped start examples agree with the runtime action parser and published state schema", () => {
  const request = read("contracts/examples/start-request.json");
  assert.deepEqual(parseAction(request), request);
  assert.equal(request.action, "start");
  const response = read("contracts/examples/start-response.json");
  assert.equal(response.contract_version, CONTRACT_VERSION);
  assert.equal(response.ok, true);
  const validateState = new Ajv2020({ strict: false, allErrors: true }).compile(
    read("contracts/state-v0.1.schema.json"),
  );
  assert.equal(
    validateState(response.run),
    true,
    JSON.stringify(validateState.errors),
  );
  assert.equal(response.run.state, "queued");
  assert.equal(response.run.terminal, false);
  assert.equal(response.run.verification, "not_run");
  assert.equal(response.run.application, "not_applicable");
});
