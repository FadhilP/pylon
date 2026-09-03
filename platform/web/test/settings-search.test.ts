import assert from "node:assert/strict";
import test from "node:test";
import type { PackageSummary } from "../src/shared/protocol/snapshots.ts";
import { buildSettingsSearchIndex, searchSettings } from "../src/shared/settings-search.ts";

type SearchInput = Parameters<typeof buildSettingsSearchIndex>[0];

const packageWithSettings: PackageSummary = {
  id: "pi-history",
  name: "History Tools",
  description: "Controls retained session history.",
  enabled: true,
  active: true,
  extensionCount: 1,
  settings: {
    kind: "generic",
    packageId: "pi-history",
    fields: [
      {
        version: 1,
        key: "retentionDays",
        label: "History retention",
        type: "string-list",
        defaultValue: [],
        value: ["private-current-value"],
        description: "Number of days to retain session history.",
        apply: "next-session",
      },
      {
        version: 1,
        key: "reviewInstructions",
        label: "Review instructions",
        type: "prompt",
        defaultValue: { mode: "default", text: "" },
        value: { mode: "append", text: "private-prompt-content" },
        allowedModes: ["default", "append"],
        maxBytes: 32_768,
        apply: "next-session",
      },
    ],
  },
};

function buildInput(overrides: Partial<SearchInput> = {}): SearchInput {
  return {
    providers: [],
    models: [],
    packages: [],
    toolPolicies: [],
    ...overrides,
  };
}

test("settings search ranks a direct label match first", () => {
  const results = searchSettings(buildSettingsSearchIndex(buildInput()), "guard timeout");

  assert.equal(results[0]?.target, "guard-timeout");
});

test("settings search builds navigable destinations for loaded package and hook settings", () => {
  const index = buildSettingsSearchIndex(buildInput({
    packages: [packageWithSettings],
    hookSettings: {
      sessionStart: {
        enabled: true,
        sources: [
          {
            id: "team-rules",
            name: "Team conventions",
            kind: "text",
            content: "private-hook-content",
          },
        ],
      },
      beforeAgentStart: { enabled: false, sources: [] },
    },
  }));

  const packageResult = searchSettings(index, "retention days")[0];
  assert.equal(packageResult?.packageId, "pi-history");
  assert.equal(packageResult?.target, "history-retention");
  assert.deepEqual(packageResult?.control, { kind: "package-field", packageId: "pi-history" });
  assert.deepEqual(searchSettings(index, "History Tools")[0]?.control, {
    kind: "package",
    packageId: "pi-history",
  });
  assert.equal(searchSettings(index, "Review instructions")[0]?.control, undefined);

  const hookResult = searchSettings(index, "team conventions")[0];
  assert.equal(hookResult?.hookKey, "sessionStart");
  assert.equal(hookResult?.hookSourceId, "team-rules");
  assert.equal(hookResult?.target, "hook-source-team-rules");
});

test("settings search indexes discoverable names but not editable values or hook contents", () => {
  const index = buildSettingsSearchIndex(buildInput({
    providers: [{ id: "openai", name: "OpenAI" }],
    models: [{ provider: "openai", id: "gpt-5", name: "GPT 5" }],
    packages: [packageWithSettings],
    hookSettings: {
      sessionStart: {
        enabled: true,
        sources: [{ id: "private", name: "Startup rules", kind: "text", content: "private-hook-content" }],
      },
      beforeAgentStart: { enabled: false, sources: [] },
    },
  }));

  assert.equal(searchSettings(index, "openai")[0]?.tab, "providers");
  assert.ok(searchSettings(index, "gpt 5").some(result => result.tab === "models"));
  assert.deepEqual(searchSettings(index, "gpt 5")[0]?.control, { kind: "model", modelKey: "openai/gpt-5" });
  assert.deepEqual(searchSettings(index, "color theme")[0]?.control, { kind: "theme" });
  assert.deepEqual(searchSettings(index, "private current value"), []);
  assert.deepEqual(searchSettings(index, "private hook content"), []);
  assert.deepEqual(searchSettings(index, "private prompt content"), []);
});


test("settings search exposes tool controls with the owning package context", () => {
  const index = buildSettingsSearchIndex(buildInput({
    packages: [packageWithSettings],
    toolPolicies: [{
      owner: "pi-history",
      managedTools: ["archive_history"],
      enabledTools: ["archive_history"],
      deferredTools: [],
    }],
  }));

  assert.deepEqual(searchSettings(index, "archive history")[0]?.control, {
    kind: "tool",
    packageId: "pi-history",
    tool: "archive_history",
  });
});
