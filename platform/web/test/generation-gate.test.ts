import test from "node:test";
import assert from "node:assert/strict";
import { GenerationGate } from "../src/server/pi/generation-gate.ts";

test("generation gate rejects old callbacks through replacement", () => {
  const gate = new GenerationGate();
  assert.equal(gate.start(), 1);
  assert.equal(gate.accepts(1), true);

  assert.equal(gate.beginReplacement(), 2);
  assert.equal(gate.accepts(1), false, "session events stop while replacement is pending");
  assert.equal(gate.acceptsUi(1), true, "pre-replacement safety dialogs remain answerable");
  assert.equal(gate.invalidateCurrent(), 2);
  assert.equal(gate.accepts(1), false);
  assert.equal(gate.acceptsUi(1), false);
  assert.equal(gate.commitReplacement(), 2);
  assert.equal(gate.accepts(2), true);
  assert.equal(gate.accepts(1), false);
  assert.throws(() => gate.assert(1), { name: "StaleGenerationError" });
});

test("cancelled replacement preserves current generation", () => {
  const gate = new GenerationGate();
  gate.start();
  gate.beginReplacement();
  gate.cancelReplacement();
  assert.equal(gate.generation, 1);
  assert.equal(gate.accepts(1), true);
});

test("failed replacement remains unavailable at allocated generation", () => {
  const gate = new GenerationGate();
  gate.start();
  gate.beginReplacement();
  gate.invalidateCurrent();
  gate.failReplacement();
  assert.equal(gate.generation, 2);
  assert.equal(gate.ready, false);
  assert.equal(gate.accepts(2), false);

  assert.equal(gate.beginRecovery(), 3);
  assert.equal(gate.commitReplacement(), 3);
  assert.equal(gate.ready, true);
});
