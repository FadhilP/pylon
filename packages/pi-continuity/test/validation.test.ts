import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProposalBatch } from "../src/memory.ts";

test("proposal validation rejects secrets and path traversal", () => {
  assert.throws(
    () =>
      normalizeProposalBatch([
        {
          operation: "add",
          scope: "user",
          trigger: "using auth",
          guidance: "Use token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
          basis: {
            type: "user_instruction",
            quote: "Use token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
          },
        },
      ]),
    /invalid|credential|safety/,
  );
  assert.throws(
    () =>
      normalizeProposalBatch([
        {
          operation: "add",
          scope: "project",
          trigger: "changing config",
          guidance: "Keep the boundary.",
          basis: { type: "project_contract", evidence: [{ path: "../secret", start: 1, end: 1 }] },
        },
      ]),
    /invalid/,
  );
});
