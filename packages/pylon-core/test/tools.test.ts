import test from "node:test";
import assert from "node:assert/strict";
import {
  parseToolMessage,
  PROTOCOL_VERSION,
  reconcileTools,
} from "../src/tools.ts";

test("managed tools merge without lost updates", () => {
  const tools = reconcileTools(
    ["read", "edit"],
    [
      {
        owner: "pi-advisor",
        managedTools: ["advisor"],
        enabledTools: ["advisor"],
      },
      { owner: "pi-scout", managedTools: ["repo_scout"], enabledTools: [] },
    ],
  );
  assert.deepEqual(new Set(tools), new Set(["read", "edit", "advisor"]));
});

test("deferred tools stay hidden until selected", () => {
  const policies = [
    {
      owner: "pi-test",
      managedTools: ["specialist"],
      enabledTools: ["specialist"],
      deferredTools: ["specialist"],
    },
  ];
  assert.deepEqual(reconcileTools(["read"], policies), ["read"]);
  assert.deepEqual(
    reconcileTools(["read"], policies, { selectedTools: ["specialist"] }),
    ["read", "specialist"],
  );
});

test("multiple gates intersect fail closed", () => {
  const tools = reconcileTools(
    ["read", "edit"],
    [
      {
        owner: "pi-continuity",
        managedTools: ["continuity_update"],
        enabledTools: ["continuity_update"],
        allowOnly: ["read", "continuity_update", "repo_scout"],
      },
      {
        owner: "pi-other",
        managedTools: ["repo_scout"],
        enabledTools: ["repo_scout"],
        allowOnly: ["read", "repo_scout"],
      },
    ],
  );
  assert.deepEqual(tools, ["read", "repo_scout"]);
});

test("manual overrides apply before restrictive gates", () => {
  const policies = [
    {
      owner: "pi-test",
      managedTools: ["specialist"],
      enabledTools: ["specialist"],
      allowOnly: ["read", "specialist"],
    },
  ];
  const capable = new Set(["read", "edit", "specialist", "extra"]);
  assert.deepEqual(
    reconcileTools(["read", "edit"], policies, {
      overrides: [
        ["edit", "disabled"],
        ["extra", "active"],
      ],
      capable,
    }),
    ["read", "specialist"],
  );
  assert.deepEqual(
    reconcileTools(["read"], [], { overrides: [["extra", "active"]], capable }),
    ["read", "extra"],
  );
  assert.deepEqual(
    reconcileTools(["read"], [], {
      overrides: [["unknown", "active"]],
      capable,
    }),
    ["read"],
  );
});
