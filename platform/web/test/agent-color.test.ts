import assert from "node:assert/strict";
import test from "node:test";
import { agentColorTokens, assignAgentColorSlots } from "../src/shared/agent-colors.ts";

const agent = (id: string, threadId?: string) => ({ id, ...(threadId ? { threadId } : {}) });

test("agent colors stay stable, reuse freed slots, and group spawned threads", () => {
  const first = assignAgentColorSlots(new Map(), [agent("a"), agent("b"), agent("turn-1", "thread")]);
  assert.deepEqual([...first], [["a", 0], ["b", 1], ["thread", 2]]);

  const next = assignAgentColorSlots(first, [agent("b"), agent("turn-2", "thread"), agent("c")]);
  assert.equal(next.get("b"), 1);
  assert.equal(next.get("thread"), 2);
  assert.equal(next.get("c"), 0);
  assert.equal(next.size, 3);
});

test("the full retained agent set receives unique muted colors", () => {
  const agents = Array.from({ length: 100 }, (_, index) => agent(`agent-${index}`));
  const slots = assignAgentColorSlots(new Map(), agents);
  const values = [...slots.values()].map((slot) => agentColorTokens(slot).color);

  assert.equal(slots.size, 100);
  assert.equal(new Set(slots.values()).size, 100);
  assert.equal(new Set(values).size, 100);
  assert.ok(values.every((value) => /^hsl\(\d+ 24% 56%\)$/.test(value)));
});
