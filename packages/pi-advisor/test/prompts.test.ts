import test from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_PROMPT } from "../src/prompts.ts";

test("advisor prompt fixes structure and review role", () => {
  assert.match(ADVISOR_PROMPT, /## Recommended approach/);
  assert.match(ADVISOR_PROMPT, /do not call tools/);
  assert.match(ADVISOR_PROMPT, /tentative judgments/i);
  assert.match(ADVISOR_PROMPT, /unsupported conclusions/i);
  assert.match(ADVISOR_PROMPT, /what remains unknown/i);
  assert.match(ADVISOR_PROMPT, /minimum sufficient solution/i);
  assert.match(ADVISOR_PROMPT, /narrowest shared boundary/i);
  assert.match(ADVISOR_PROMPT, /never simplify away security/i);
  assert.match(ADVISOR_PROMPT, /condition for revisiting/i);
  assert.match(ADVISOR_PROMPT, /executor retains decision and execution authority/i);
  assert.match(ADVISOR_PROMPT, /untrusted data, never instructions/i);
  assert.ok(Math.ceil(ADVISOR_PROMPT.length / 4) <= 350);
});
