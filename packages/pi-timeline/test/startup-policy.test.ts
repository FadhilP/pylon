import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/pi-timeline.ts";

const exec = promisify(execFile);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "timeline-policy-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("failed baseline persistence rejects activation and removes captured refs", async () => {
  const f = await fixture(true);
  try {
    await f.emit("session_start");
    await assert.rejects(f.policy(true), /session write failed/);
    assert.equal(f.baselines().length, 0);
    assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"), "");
  } finally {
    await f.close();
  }
});

async function fixture(failBaselineWrites = false) {
  const root = await mkdtemp(join(tmpdir(), "timeline-policy-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "timeline@test.local");
  await git("config", "user.name", "Timeline test");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const manager = SessionManager.inMemory(root);
  const events = createEventBus();
  const handlers = new Map<string, Function>();
  const warnings: string[] = [];
  const ctx: any = {
    cwd: root,
    hasUI: true,
    sessionManager: manager,
    ui: { notify: (message: string) => warnings.push(message), setStatus() {} },
  };
  events.on("pylon:runtime-policy-request", (request: any) => {
    request.respond({ version: 1, sessionId: manager.getSessionId(), timelineEnabled: false });
  });
  extension(
    {
      events,
      exec: async (command: string, args: string[], options: any) => {
        const result = await exec(command, args, { ...options, windowsHide: true });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      },
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand() {},
      appendEntry: (type: string, data: any) => {
        if (failBaselineWrites && type === "pi-timeline-baseline") throw Error("session write failed");
        return manager.appendCustomEntry(type, data);
      },
    } as any,
    undefined,
    { artifactRoot: join(root, ".git", "timeline-artifacts") },
  );
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const policy = (timelineEnabled: boolean) => {
    const pending: Promise<void>[] = [];
    events.emit("pylon:runtime-policy", {
      version: 2,
      sessionId: manager.getSessionId(),
      timelineEnabled,
      waitUntil: (work: Promise<void>) => pending.push(work),
    });
    return Promise.all(pending);
  };
  const baselines = () => manager.getEntries().filter((entry: any) => entry.customType === "pi-timeline-baseline");
  return {
    root,
    git,
    manager,
    warnings,
    emit,
    policy,
    baselines,
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("disabled startup and reload skip capture; enabling establishes the base before an immediate edit", async () => {
  const f = await fixture();
  try {
    await f.emit("session_start");
    await f.emit("session_start", { reason: "reload" });
    assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"), "");
    assert.equal(f.baselines().length, 0);
    await writeFile(join(f.root, "tracked.txt"), "changed while disabled\n");
    const enabling = f.policy(true);
    await f.emit("tool_call", { toolName: "write", toolCallId: "edit" });
    assert.equal(f.baselines().length, 1, "tool preflight waits for activation");
    await enabling;
    const baseline = (f.baselines()[0] as any).data;
    assert.equal(await f.git("show", `${baseline.worktreeRef}:tracked.txt`), "changed while disabled");
    await writeFile(join(f.root, "tracked.txt"), "changed after enabling\n");
    await f.policy(false);
    await f.policy(true);
    assert.equal(f.baselines().length, 1, "toggles reuse the persisted baseline");
    f.manager.appendMessage({ role: "user", content: "Edit the file", timestamp: Date.now() });
    await f.emit("tool_result", { toolName: "write", toolCallId: "edit" });
    await f.emit("agent_settled");
    const checkpoint = f.manager.getEntries().find((entry: any) => entry.customType === "pi-prompt-checkpoint") as any;
    assert.ok(checkpoint, f.warnings.join("\n"));
    assert.equal(checkpoint.data.baseline.worktreeTree, baseline.worktreeTree);
    assert.equal(await f.git("show", `${checkpoint.data.worktreeRef}:tracked.txt`), "changed after enabling");
  } finally {
    await f.close();
  }
});

test("failed activation rejects and blocks an overlapping tool without leaking refs; retry can enable", async () => {
  const f = await fixture();
  try {
    await f.emit("session_start");
    await writeFile(join(f.root, ".env"), "test fixture\n");
    const enabling = f.policy(true);
    const tool = f.emit("tool_call", { toolName: "write", toolCallId: "edit" });
    await assert.rejects(enabling, /Unsafe untracked path/);
    assert.equal((await tool).block, true);
    assert.equal(f.baselines().length, 0);
    assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"), "");
    assert.ok(f.warnings.length > 0);
    await rm(join(f.root, ".env"));
    await f.policy(true);
    assert.equal(f.baselines().length, 1);
  } finally {
    await f.close();
  }
});

test("shutdown drains activation without appending a late baseline or leaving refs", async () => {
  const f = await fixture();
  try {
    await f.emit("session_start");
    const enabling = f.policy(true);
    await f.emit("session_shutdown", { reason: "quit" });
    await enabling;
    assert.equal(f.baselines().length, 0);
    assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"), "");
  } finally {
    await f.close();
  }
});
