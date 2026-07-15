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
      { owner: "pi-advisor", managedTools: ["advisor"], enabledTools: ["advisor"] },
      { owner: "pi-scout", managedTools: ["repo_scout"], enabledTools: [] },
    ],
  );
  assert.deepEqual(new Set(tools), new Set(["read", "edit", "advisor"]));
});

test("multiple gates intersect fail closed", () => {
  const tools = reconcileTools(
    ["read", "edit"],
    [
      { owner: "pi-continuity", managedTools: ["continuity_update"], enabledTools: ["continuity_update"], allowOnly: ["read", "continuity_update", "repo_scout"] },
      { owner: "pi-other", managedTools: ["repo_scout"], enabledTools: ["repo_scout"], allowOnly: ["read", "repo_scout"] },
    ],
  );
  assert.deepEqual(tools, ["read", "repo_scout"]);
});

test("protocol validates version, owners, and managed subsets", () => {
  assert.deepEqual(
    parseToolMessage({ version: PROTOCOL_VERSION, kind: "unregister", owner: "pi-scout" }),
    { message: { version: PROTOCOL_VERSION, kind: "unregister", owner: "pi-scout" } },
  );
  assert.match((parseToolMessage({ version: 2, kind: "unregister", owner: "pi-scout" }) as any).error, /version/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "bad", managedTools: [], enabledTools: [] }) as any).error, /owner/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "pi-test", managedTools: [], enabledTools: ["read"] }) as any).error, /subset/);
});
