import test from "node:test";
import assert from "node:assert/strict";
import { buildParentContext } from "../src/parent-context.ts";

test("parent context carries current request and bounded plan intent safely", () => {
  const context = buildParentContext([
    {
      type: "message",
      message: { role: "user", content: "Add OAuth login" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "continuity_update",
            arguments: {
              action: "set_plan",
              planSummary: "Inspect routes, then add callback handling",
              token: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: { role: "user", content: "Execute approved stored plan." },
    },
  ]);
  assert.match(context, /Add OAuth login/);
  assert.match(context, /Inspect routes, then add callback handling/);
  assert.match(context, /Execute approved stored plan/);
  assert.doesNotMatch(context, /abcdefghijklmnopqrstuvwxyz/);
  assert.ok(context.length <= 6000);
});

test("parent context includes bounded verification and checkpoint archaeology", () => {
  const context = buildParentContext([
    { type: "custom", customType: "pi-verify-result", data: { state: "failed", scope: "changed", results: [{ command: "npm test" }] } },
    { type: "custom", customType: "pi-prompt-checkpoint", data: { createdAt: "2026-01-01", worktreeRef: "secret-ref", indexRef: "secret-index" } },
  ]);
  assert.match(context, /pi-verify-result/);
  assert.match(context, /npm test/);
  assert.match(context, /pi-prompt-checkpoint/);
  assert.doesNotMatch(context, /secret-ref|secret-index/);
});

test("parent context deduplicates clipped items and keeps roles distinct", () => {
  const context = buildParentContext([
    { type: "message", message: { role: "user", content: "older constraint" } },
    { type: "message", message: { role: "user", content: "same\r\nevidence" } },
    { type: "message", message: { role: "user", content: "same\nevidence" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "same\nevidence" }] } },
  ], 6000, 3);
  assert.match(context, /older constraint/);
  assert.equal(context.match(/same/g)?.length, 2);
  assert.match(context, /User:/);
  assert.match(context, /Main assistant:/);
});

test("parent context keeps complete newest items within its total cap", () => {
  const context = buildParentContext([
    { type: "message", message: { role: "user", content: `older ${"alpha ".repeat(150)}` } },
    { type: "message", message: { role: "user", content: `newest ${"bravo ".repeat(150)}` } },
  ], 1000, 2);
  assert.match(context, /newest/);
  assert.doesNotMatch(context, /older/);
  assert.ok(context.length <= 1000);
});

test("parent context removes records that become duplicates after clipping", () => {
  const shared = "shared words ".repeat(110);
  const context = buildParentContext([
    { type: "message", message: { role: "user", content: `${shared}old` } },
    { type: "message", message: { role: "user", content: `${shared}new` } },
  ]);
  assert.equal(context.length, 1200);
  assert.equal(context.match(/User:/g)?.length, 1);
});

test("parent context omits recursive scout calls and caps output", () => {
  const context = buildParentContext(
    Array.from({ length: 20 }, (_, i) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `${i} ${"x".repeat(2000)}` },
          { type: "toolCall", name: "repo_scout", arguments: { task: "repeat" } },
        ],
      },
    })),
    2000,
    4,
  );
  assert.doesNotMatch(context, /repeat/);
  assert.ok(context.length <= 2000);
  assert.match(context, /19 /);
});
