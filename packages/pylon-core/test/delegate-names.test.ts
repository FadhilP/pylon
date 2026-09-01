import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATE_NAME_IMMUTABLE_FOOTER,
  createDelegateNames,
  delegateNamingPrompt,
  NAME_PROMPT,
  normalizeDelegateName,
  requestDelegateName,
} from "../src/delegate-names.ts";
import { saveConfig } from "../src/config.ts";

class Bus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  on(channel: string, handler: (value: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel: string, value: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
}

async function harness(completeName: (...args: any[]) => Promise<any>) {
  const root = await mkdtemp(join(tmpdir(), "pylon-delegate-names-"));
  const path = join(root, "config.json");
  await saveConfig({ version: 1, lineEditEnabled: true, delegateNamingModel: "cheap/namer" }, path);
  const events = new Bus();
  const entries: Array<{ customType: string; data: any }> = [];
  const pi = { events, appendEntry: (customType: string, data: any) => entries.push({ customType, data }) };
  const coordinator = createDelegateNames(pi as any, completeName as any, { configPath: path });
  const model = { provider: "cheap", id: "namer" };
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
  };
  await coordinator.rebuild(ctx);
  return { root, pi: pi as any, coordinator, entries, ctx };
}

test("delegate naming customization is append-only and retains its immutable footer", () => {
  assert.equal(delegateNamingPrompt(), NAME_PROMPT);
  const prompt = delegateNamingPrompt({ mode: "append", text: "Prefer repository terms." });
  assert.match(prompt, /## Operator customization\nPrefer repository terms\./);
  assert.ok(prompt.endsWith(DELEGATE_NAME_IMMUTABLE_FOOTER));
});

test("delegate naming starts with the role fallback and settles to a bounded semantic name", async () => {
  let finish!: (value: any) => void;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const f = await harness(async () => pending);
  try {
    const handle = requestDelegateName(f.pi, {
      kind: "advisor",
      callId: "advisor-call",
      task: "Review how the authentication migration should be staged",
    });
    assert.equal(handle.getName(), "Advisor-1");
    let settled = false;
    void handle.settled.then(() => {
      settled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "naming must remain independent while the delegated work starts");

    finish({ content: [{ type: "text", text: "auth-migration" }] });
    assert.equal(await handle.settled, "auth-migration");
    assert.equal(handle.getName(), "auth-migration");
    assert.deepEqual(f.entries, [
      {
        customType: "pylon-delegate-name",
        data: { version: 1, key: "advisor-call", name: "auth-migration", fallbackName: "Advisor-1" },
      },
    ]);
  } finally {
    f.coordinator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("semantic names keep at most three kebab words and duplicate allocation stays unique within 24 characters", async () => {
  const outputs = ["abcdefghijk-abcdefghijkl", "abcdefghijk-abcdefghijkl", "name: spawn-review"];
  const f = await harness(async () => ({ content: [{ type: "text", text: outputs.shift()! }] }));
  try {
    const first = requestDelegateName(f.pi, { kind: "repo_scout", callId: "scout-1", task: "first" });
    assert.equal(await first.settled, "abcdefghijk-abcdefghijkl");

    const second = requestDelegateName(f.pi, { kind: "grunt", callId: "grunt-1", task: "second" });
    const duplicate = await second.settled;
    assert.match(duplicate, /-2$/);
    assert.ok(duplicate.length <= 24);

    const spawn = requestDelegateName(f.pi, {
      kind: "spawn_agent",
      callId: "spawn-call",
      identityId: "pi-spawn:agent:thread-1",
      task: "third",
      fallbackName: "Ada",
    });
    assert.equal(await spawn.settled, "Ada", "invalid model output preserves the scientist fallback");
    assert.equal(normalizeDelegateName("docs-writer"), "docs-writer");
    assert.equal(normalizeDelegateName("image-sharing-review"), "image-sharing-review");
    assert.equal(normalizeDelegateName("one-two-three-four"), "one-two-three");
    assert.equal(normalizeDelegateName("architecture-pylon-verylongword"), "architecture-pylon");
    assert.equal(normalizeDelegateName("abcdefghijklmnopqrstuvwxyz-sharing-review"), undefined);
  } finally {
    f.coordinator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("persisted semantic names and legacy counters rebuild on the active branch", async () => {
  let calls = 0;
  const f = await harness(async () => {
    calls++;
    return { content: [{ type: "text", text: "unused-name" }] };
  });
  try {
    const branch = [
      {
        type: "custom",
        customType: "pylon-delegate-name",
        data: { version: 1, key: "pi-spawn:agent:thread-1", name: "docs-writer", fallbackName: "Ada" },
      },
      { type: "message", message: { role: "toolResult", toolCallId: "scout-7", details: { agentName: "S7" } } },
    ];
    await f.coordinator.rebuild({ ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getBranch: () => branch } });

    const spawn = requestDelegateName(f.pi, {
      kind: "spawn_agent",
      callId: "new-spawn-call",
      identityId: "pi-spawn:agent:thread-1",
      task: "continue the docs work",
      fallbackName: "Ada",
    });
    assert.equal(await spawn.settled, "docs-writer");
    assert.equal(calls, 0);

    let scout = "";
    f.pi.events.emit("pylon:delegate-name", {
      version: 1,
      kind: "web_scout",
      callId: "scout-8",
      respond: (value: string) => {
        scout = value;
      },
    });
    assert.equal(scout, "Scout-8");
  } finally {
    f.coordinator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
