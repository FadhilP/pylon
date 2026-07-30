import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceApplyTool } from "../src/server/pi/workspace-apply-tool.ts";

function loadTool(bridge: WorkspaceApplyTool) {
  let registered: any;
  let beforeAgentStart: (() => unknown) | undefined;
  const factory = typeof bridge.extension === "function"
    ? bridge.extension
    : bridge.extension.factory;
  factory({
    on(event: string, handler: () => unknown) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerTool(tool: unknown) {
      registered = tool;
    },
  } as any);
  return {
    registered,
    beforeAgentStart: () => beforeAgentStart?.(),
  };
}

test("workspace apply tool fails closed and schedules the approved revision once", async () => {
  const bridge = new WorkspaceApplyTool();
  const { registered, beforeAgentStart } = loadTool(bridge);
  const requests: unknown[] = [];
  bridge.setHandler(async (request) => {
    requests.push(request);
    if (request.type === "inspect") {
      return {
        available: true,
        targetBranch: "main",
        changedCount: 2,
        revision: "revision-1",
        mode: "worktree",
      };
    }
  });

  const noUi = await registered.execute("call", {}, undefined, undefined, { hasUI: false });
  assert.match(noUi.content[0].text, /confirmation UI is unavailable/);
  const approved = await registered.execute("call", {}, undefined, undefined, {
    hasUI: true,
    ui: { confirm: async () => true },
  });
  assert.match(approved.content[0].text, /scheduled after this turn/);
  assert.deepEqual(requests.at(-1), { type: "schedule", revision: "revision-1" });

  bridge.recordResult("Applied to main.");
  assert.deepEqual(beforeAgentStart(), {
    message: {
      customType: "pylon-workspace-apply-result",
      display: false,
      content: "Applied to main.",
    },
  });
  assert.equal(beforeAgentStart(), undefined);
});
