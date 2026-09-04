import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  packageSettingsRevision,
  patchPackageSettings,
  PylonSettingsTool,
  type PylonSettingsPreview,
} from "../src/server/pi/pylon-settings-tool.ts";
import { SessionRuntime } from "../src/server/pi/session-runtime.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const initial = {
  kind: "generic" as const,
  packageId: "pylon-core",
  fields: [
    {
      version: 1 as const,
      key: "enabled",
      label: "Enabled",
      type: "boolean" as const,
      defaultValue: true,
      value: true,
      apply: "next-session" as const,
    },
  ],
};

function loadTool(bridge: PylonSettingsTool) {
  let registered: any;
  let activeTools = ["read"];
  const factory = typeof bridge.extension === "function" ? bridge.extension : bridge.extension.factory;
  factory({
    events: {
      emit(_channel: string, value: any) {
        value?.acknowledge?.();
      },
    },
    on() {},
    registerTool(tool: any) {
      registered = tool;
      activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
  } as any);
  return registered;
}

function text(result: any): string {
  return result.content[0].text;
}

test("package settings patches validate keys, values, and apply timing", () => {
  const changed = patchPackageSettings(initial, { enabled: false });
  assert.equal(changed.settings.kind, "generic");
  assert.deepEqual(changed.changes, [
    { key: "enabled", previous: true, next: false, apply: "next-session", highImpact: false },
  ]);
  assert.notEqual(packageSettingsRevision(initial), packageSettingsRevision(changed.settings));
  assert.throws(() => patchPackageSettings(initial, { trusted: true }), /not a configurable/);
  assert.throws(() => patchPackageSettings(initial, { enabled: "yes" }), /proposed package settings are invalid/);
});

test("settings tool requires UI approval and commits only the approved revision", async () => {
  const bridge = new PylonSettingsTool();
  const tool = loadTool(bridge);
  const revision = packageSettingsRevision(initial);
  const requests: string[] = [];
  const preview: PylonSettingsPreview = {
    packageId: "pylon-core",
    revision,
    settings: patchPackageSettings(initial, { enabled: false }).settings,
    changes: patchPackageSettings(initial, { enabled: false }).changes,
  };
  bridge.setHandler(async request => {
    requests.push(request.type);
    if (request.type === "preview") return preview;
    if (request.type === "update") return { ...preview, revision: "0123456789abcdef" };
    if (request.type === "get") return { packageId: "pylon-core", revision, settings: initial };
    return { packages: [] };
  });

  const input = { action: "update", packageId: "pylon-core", revision, changes: { enabled: false } };
  const noUi = await tool.execute("call", input, undefined, undefined, { hasUI: false });
  assert.match(text(noUi), /confirmation UI is unavailable/);
  assert.deepEqual(requests, ["preview"]);

  const denied = await tool.execute("call", input, undefined, undefined, {
    hasUI: true,
    ui: { confirm: async () => false },
  });
  assert.match(text(denied), /declined/);
  assert.deepEqual(requests, ["preview", "preview"]);

  let confirmation = "";
  const approved = await tool.execute("call", input, undefined, undefined, {
    hasUI: true,
    ui: {
      confirm: async (_title: string, body: string) => {
        confirmation = body;
        return true;
      },
    },
  });
  assert.match(confirmation, /enabled: true → false \[next-session\]/);
  assert.match(text(approved), /0123456789abcdef/);
  assert.deepEqual(requests, ["preview", "preview", "preview", "update"]);
});

test("settings tool surfaces a stale revision before requesting confirmation", async () => {
  const bridge = new PylonSettingsTool();
  const tool = loadTool(bridge);
  bridge.setHandler(async () => {
    throw new Error("pylon-core settings changed; call get again before updating");
  });
  let confirmations = 0;
  const output = await tool.execute(
    "call",
    { action: "update", packageId: "pylon-core", revision: "0123456789abcdef", changes: { enabled: false } },
    undefined,
    undefined,
    { hasUI: true, ui: { confirm: async () => (++confirmations, true) } },
  );
  assert.match(text(output), /settings changed; call get again/);
  assert.equal(confirmations, 0);
});

test(
  "web runtime settings tool persists an approved patch and rejects its stale revision",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pylon-settings-tool-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const driver = new SessionRuntime();
    try {
      await driver.start({ cwd, agentDir, repositoryRoot, inMemory: true });
      const docsTool = (driver as any).runtime.session.getToolDefinition("pylon_docs");
      assert.ok(docsTool);
      const docs = JSON.parse(
        text(await docsTool.execute("docs-list", { action: "list" }, undefined, undefined, { mode: "rpc" })),
      );
      assert.equal(docs.host, "web");
      assert.match(docs.guidance, /Prefer supported Web panels/);
      const tool = (driver as any).runtime.session.getToolDefinition("pylon_settings");
      assert.ok(tool);
      const list = JSON.parse(
        text(await tool.execute("list", { action: "list" }, undefined, undefined, { hasUI: false })),
      );
      const advisor = list.packages.find((item: any) => item.packageId === "pi-advisor");
      assert.ok(advisor.keys.includes("model"), "optional writable settings remain discoverable");
      assert.ok(!advisor.keys.includes("promptDefaultText"), "derived display text is not writable");
      const read = await tool.execute("get", { action: "get", packageId: "pylon-core" }, undefined, undefined, {
        hasUI: false,
      });
      const current = JSON.parse(text(read));
      const input = {
        action: "update",
        packageId: "pylon-core",
        revision: current.revision,
        changes: { delegateMaxAttempts: 4 },
      };

      const noUi = await tool.execute("no-ui", input, undefined, undefined, { hasUI: false });
      assert.match(text(noUi), /confirmation UI is unavailable/);
      let confirmation = "";
      const updated = await tool.execute("update", input, undefined, undefined, {
        hasUI: true,
        ui: {
          confirm: async (_title: string, body: string) => {
            confirmation = body;
            return true;
          },
        },
      });
      assert.match(confirmation, /delegateMaxAttempts: 3 → 4 \[next-operation\]/);
      assert.match(text(updated), /"delegateMaxAttempts"/);

      const persisted = (await driver.listPackages()).packages.find(item => item.id === "pylon-core")?.settings;
      assert.equal(
        persisted?.kind === "generic"
          ? persisted.fields.find(field => field.key === "delegateMaxAttempts")?.value
          : undefined,
        4,
      );
      let staleConfirmation = false;
      const stale = await tool.execute("stale", input, undefined, undefined, {
        hasUI: true,
        ui: { confirm: async () => ((staleConfirmation = true), true) },
      });
      assert.match(text(stale), /settings changed; call get again/);
      assert.equal(staleConfirmation, false);
    } finally {
      await driver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
