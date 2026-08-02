import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimePolicyReadModel } from "../src/shared/protocol/snapshots.ts";
import { formatPolicyTimeout, runtimePolicySources } from "../src/shared/runtime-policy-format.ts";

function policy(overrides: Partial<Pick<RuntimePolicyReadModel, "project" | "session">> = {}): RuntimePolicyReadModel {
  return {
    revision: 1,
    global: {
      timelineEnabled: true,
      guardEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    project: overrides.project ?? { verify: { mode: "auto" } },
    session: overrides.session ?? {},
    effective: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      guardEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    availableVerifyChecks: [],
  };
}

test("runtime policy sources follow structural overrides", () => {
  assert.deepEqual(runtimePolicySources(policy()), {
    verify: "Project",
    timeline: "Global",
    guard: "Global",
    workspace: "Global",
    guardTimeout: "Global",
    clarifyTimeout: "Global",
  });

  assert.deepEqual(runtimePolicySources(policy({
    project: {
      verify: { mode: "selected", checks: ["npm:test"] },
      timelineEnabled: false,
      guardTimeoutSeconds: null,
    },
    session: {
      verify: { mode: "auto" },
      guardEnabled: false,
      workspace: "worktree",
      clarifyTimeoutSeconds: null,
    },
  })), {
    verify: "This session",
    timeline: "Project",
    guard: "This session",
    workspace: "This session",
    guardTimeout: "Project",
    clarifyTimeout: "This session",
  });
});

test("policy timeout labels preserve Never and natural units", () => {
  assert.equal(formatPolicyTimeout(null), "Never");
  assert.equal(formatPolicyTimeout(30), "30 seconds");
  assert.equal(formatPolicyTimeout(60), "1 minute");
  assert.equal(formatPolicyTimeout(7_200), "2 hours");
});
