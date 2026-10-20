import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => JSON.parse(readFileSync(new URL("../"+p, import.meta.url), "utf8"));
test("action schema has exactly six actions", () => {
  const s = read("contracts/primitive-runtime-actions.schema.json");
  assert.deepEqual(s.oneOf.map(x => x.$ref.split("/").pop()).sort(), ["artifact","cancel","capabilities","result","start","status"]);
  for (const action of Object.values(s.$defs).filter(x => x.type === "object" && x.properties?.action))
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
