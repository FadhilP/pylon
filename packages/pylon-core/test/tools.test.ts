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

test("deferred tools stay hidden until selected", () => {
  const policies = [{
    owner: "pi-test",
    managedTools: ["specialist"],
    enabledTools: ["specialist"],
    deferredTools: ["specialist"],
  }];
  assert.deepEqual(reconcileTools(["read"], policies), ["read"]);
  assert.deepEqual(reconcileTools(["read"], policies, ["specialist"]), ["read", "specialist"]);
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
  assert.deepEqual(
    parseToolMessage({ version: PROTOCOL_VERSION, kind: "unregister", owner: "pylon-core" }),
    { message: { version: PROTOCOL_VERSION, kind: "unregister", owner: "pylon-core" } },
  );
  assert.match((parseToolMessage({ version: 2, kind: "unregister", owner: "pi-scout" }) as any).error, /version/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "pylon", managedTools: [], enabledTools: [] }) as any).error, /owner/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "pylon-core-extra", managedTools: [], enabledTools: [] }) as any).error, /owner/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "pi-test", managedTools: [], enabledTools: ["read"] }) as any).error, /subset/);
  assert.match((parseToolMessage({ version: 1, kind: "register", owner: "pi-test", managedTools: ["read"], enabledTools: [], deferredTools: ["read"] }) as any).error, /deferredTools.*subset/);
  const parsed = parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read"], enabledTools: ["read"], deferredTools: ["read"],
    deferredToolUsage: { read: "  inspect project files  " },
  }) as any;
  assert.deepEqual(parsed.message.deferredTools, ["read"]);
  assert.deepEqual(parsed.message.deferredToolUsage, { read: "inspect project files" });
  const generalized = parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read"], enabledTools: ["read"],
    toolUsage: { read: "  inspect project files  " },
  }) as any;
  assert.deepEqual(generalized.message.toolUsage, { read: "inspect project files" });
  assert.match((parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read", "write"], enabledTools: ["read"],
    toolUsage: { write: "change files" },
  }) as any).error, /keys must be enabled tools/);
  assert.match((parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read"], enabledTools: ["read"], deferredToolUsage: { read: "inspect files" },
  }) as any).error, /requires deferredTools/);
  assert.match((parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read"], enabledTools: ["read"], deferredTools: ["read"],
    deferredToolUsage: { write: "change files" },
  }) as any).error, /keys must be deferred tools/);
  assert.match((parseToolMessage({
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["read"], enabledTools: ["read"], deferredTools: ["read"],
    deferredToolUsage: { read: "inspect\nfiles" },
  }) as any).error, /one-line/);
});
