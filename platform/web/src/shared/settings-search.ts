import {
  GUARD_RISK_CATEGORIES,
  GUARD_RULE_DESCRIPTIONS,
  GUARD_RULE_LABELS,
} from "./guard-policy.ts";
import type { ToolPolicyReadModel } from "./protocol/events.ts";
import type {
  ExtensionListSnapshot,
  HookSettingsReadModel,
  PackageSettingsReadModel,
  PackageSummary,
} from "./protocol/snapshots.ts";

export type SettingsSearchTab =
  | "providers"
  | "models"
  | "agent-models"
  | "packages"
  | "extensions"
  | "hooks"
  | "policy"
  | "notifications"
  | "appearance";

export type SettingsSearchControl =
  | { kind: "package"; packageId: string }
  | { kind: "package-field"; packageId: string }
  | { kind: "tool"; packageId: string; tool: string }
  | { kind: "model"; modelKey: string }
  | { kind: "theme" }
  | { kind: "syntax-theme" }
  | { kind: "sound"; cue: "turn-complete" | "attention" };

export interface SettingsSearchEntry {
  id: string;
  tab: SettingsSearchTab;
  section: string;
  label: string;
  description: string;
  target: string;
  packageId?: string;
  hookKey?: keyof HookSettingsReadModel;
  hookSourceId?: string;
  control?: SettingsSearchControl;
  searchText: string;
}

interface SearchIndexInput {
  providers: Array<{ id: string; name: string }>;
  models: Array<{ id: string; name: string; provider: string }>;
  packages: PackageSummary[];
  extensions?: ExtensionListSnapshot;
  hookSettings?: HookSettingsReadModel;
  toolPolicies: ToolPolicyReadModel[];
}

interface EntryInput {
  id: string;
  tab: SettingsSearchTab;
  section: string;
  label: string;
  description?: string;
  keywords?: string;
  target?: string;
  packageId?: string;
  hookKey?: keyof HookSettingsReadModel;
  hookSourceId?: string;
  control?: SettingsSearchControl;
}

export function settingSearchTarget(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function entry(input: EntryInput): SettingsSearchEntry {
  const description = input.description ?? "";
  return {
    ...input,
    description,
    target: input.target ?? settingSearchTarget(input.label),
    searchText: normalize(`${input.section} ${input.label} ${description} ${input.keywords ?? ""}`),
  };
}

const STATIC_ENTRIES: SettingsSearchEntry[] = [
  entry({ id: "providers", tab: "providers", section: "Providers", label: "Provider accounts", description: "Connect accounts and API keys used by Pi.", keywords: "login sign in credentials" }),
  entry({ id: "models", tab: "models", section: "Models", label: "Visible models", description: "Choose which models appear in the model selector.", keywords: "hide show provider" }),
  entry({ id: "agent-models", tab: "agent-models", section: "Agent models", label: "Agent models", description: "Choose models and thinking levels used by agents and background tasks." }),
  entry({ id: "packages", tab: "packages", section: "Packages", label: "Package defaults", description: "Configure package defaults and global tool exposure." }),
  entry({ id: "extension-install", tab: "extensions", section: "Extensions", label: "Install Pi package", description: "Install an extension package globally or into a registered project.", keywords: "npm source" }),
  entry({ id: "extension-trust", tab: "extensions", section: "Extensions", label: "Project extensions", description: "Trust or revoke trust for project extensions." }),
  entry({ id: "extension-reload", tab: "extensions", section: "Extensions", label: "Reload extensions", description: "Apply changed extension settings to active sessions." }),
  entry({ id: "hook-session-start", tab: "hooks", section: "Hooks", label: "session_start", description: "Runs once when a logical session begins.", keywords: "session start lifecycle", hookKey: "sessionStart" }),
  entry({ id: "hook-before-agent-start", tab: "hooks", section: "Hooks", label: "before_agent_start", description: "Runs before every prompt sent to the agent.", keywords: "before agent start lifecycle prompt", hookKey: "beforeAgentStart" }),
  entry({ id: "policy-timeline", tab: "policy", section: "Policy › Activity and safety", label: "Timeline", description: "Keep recoverable checkpoints for session activity." }),
  entry({ id: "policy-guard", tab: "policy", section: "Policy › Activity and safety", label: "Guard", description: "Ask before guarded commands and paths run.", keywords: "approval safety" }),
  ...GUARD_RISK_CATEGORIES.map(category => entry({
    id: `policy-guard-${category}`,
    tab: "policy",
    section: "Policy › Activity and safety",
    label: GUARD_RULE_LABELS[category],
    description: GUARD_RULE_DESCRIPTIONS[category],
    keywords: "guard allow confirm block",
  })),
  entry({ id: "policy-guard-timeout", tab: "policy", section: "Policy › Activity and safety", label: "Guard timeout", description: "How long a confirmation request stays open." }),
  entry({ id: "policy-clarify-timeout", tab: "policy", section: "Policy › Activity and safety", label: "Clarify timeout", description: "How long Pylon waits for a clarification answer." }),
  entry({ id: "policy-workspace", tab: "policy", section: "Policy › Workspace defaults", label: "Workspace", description: "Choose where sessions begin work.", keywords: "local project folder checkout worktree" }),
  entry({ id: "notification-complete", tab: "notifications", section: "Notifications › Sound cues", label: "Turn complete", description: "Played after the assistant finishes a turn.", control: { kind: "sound", cue: "turn-complete" } }),
  entry({ id: "notification-attention", tab: "notifications", section: "Notifications › Sound cues", label: "Attention required", description: "Played when Pylon needs approval or clarification.", control: { kind: "sound", cue: "attention" } }),
  entry({ id: "appearance-theme", tab: "appearance", section: "Appearance", label: "Color theme", description: "Choose the color theme used throughout Pylon.", keywords: "dark light warm", control: { kind: "theme" } }),
  entry({ id: "appearance-syntax", tab: "appearance", section: "Appearance", label: "Code highlighting", description: "Choose the syntax highlighting theme.", keywords: "syntax theme language", control: { kind: "syntax-theme" } }),
];

export function buildSettingsSearchIndex(input: SearchIndexInput): SettingsSearchEntry[] {
  const entries = [...STATIC_ENTRIES];

  for (const provider of input.providers) {
    entries.push(entry({
      id: `provider-${provider.id}`,
      tab: "providers",
      section: "Providers",
      label: provider.name,
      description: provider.id,
      keywords: "account API key sign in",
      target: `provider-${settingSearchTarget(provider.id)}`,
    }));
  }
  for (const model of input.models) {
    entries.push(entry({
      id: `model-${model.provider}-${model.id}`,
      tab: "models",
      section: `Models › ${model.provider}`,
      label: model.name,
      description: model.id,
      keywords: model.provider,
      target: `model-${settingSearchTarget(`${model.provider}-${model.id}`)}`,
      control: { kind: "model", modelKey: `${model.provider}/${model.id}` },
    }));
  }
  for (const item of input.packages) {
    entries.push(entry({
      id: `package-${item.id}`,
      tab: "packages",
      section: "Packages",
      label: item.name,
      description: item.description,
      keywords: item.id,
      packageId: item.id,
      target: "package-defaults",
      control: item.required ? undefined : { kind: "package", packageId: item.id },
    }));
    for (const field of packageFields(item.settings)) {
      entries.push(entry({
        id: `package-${item.id}-${field.key}`,
        tab: "packages",
        section: `Packages › ${item.name}`,
        label: field.label,
        description: field.description,
        keywords: `${item.id} ${field.key}`,
        packageId: item.id,
        target: settingSearchTarget(field.target ?? field.label),
        control: field.inline === false ? undefined : { kind: "package-field", packageId: item.id },
      }));
    }
    if (item.id === "pi-helios") {
      entries.push(entry({
        id: "package-pi-helios-android-tooling",
        tab: "packages",
        section: `Packages › ${item.name}`,
        label: "Android tooling",
        description: "Manage Appium and UiAutomator2 used by Helios.",
        keywords: "install repair remove emulator",
        packageId: item.id,
      }));
    }
    const policy = input.toolPolicies.find(candidate => candidate.owner === item.id);
    for (const tool of policy?.managedTools ?? []) {
      entries.push(entry({
        id: `package-${item.id}-tool-${tool}`,
        tab: "packages",
        section: `Packages › ${item.name} › Tool exposure`,
        label: tool,
        description: "Set the global tool exposure default.",
        packageId: item.id,
        target: `tool-${settingSearchTarget(tool)}`,
        control: { kind: "tool", packageId: item.id, tool },
      }));
    }
  }

  for (const installed of input.extensions?.packages ?? []) {
    entries.push(entry({
      id: `extension-package-${installed.scope}-${installed.source}`,
      tab: "extensions",
      section: "Extensions › Installed packages",
      label: installed.source,
      description: installed.scope === "user" ? "Global to Pylon" : "Project package",
      target: `extension-package-${settingSearchTarget(`${installed.scope}-${installed.source}`)}`,
    }));
  }
  for (const extension of input.extensions?.extensions ?? []) {
    entries.push(entry({
      id: `extension-${extension.id}`,
      tab: "extensions",
      section: `Extensions › ${extension.scope === "user" ? "Global" : "Project"}`,
      label: extension.path,
      description: extension.source,
      keywords: extension.origin,
      target: `extension-${settingSearchTarget(extension.id)}`,
    }));
  }

  if (input.hookSettings) {
    for (const hookKey of ["sessionStart", "beforeAgentStart"] as const) {
      for (const source of input.hookSettings[hookKey].sources) {
        entries.push(entry({
          id: `hook-${hookKey}-${source.id}`,
          tab: "hooks",
          section: `Hooks › ${hookKey === "sessionStart" ? "session_start" : "before_agent_start"}`,
          label: source.name,
          description: source.kind === "file" ? "Imported hook source" : "Hook source written in Pylon",
          keywords: source.reinjectOnCompaction ? "restore after compaction" : "",
          hookKey,
          hookSourceId: source.id,
          target: `hook-source-${settingSearchTarget(source.id)}`,
        }));
      }
    }
  }

  return entries;
}

export function searchSettings(entries: SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  const tokens = normalized.split(" ");
  return entries
    .filter(candidate => tokens.every(token => candidate.searchText.includes(token)))
    .sort((left, right) => score(right, normalized) - score(left, normalized) || left.label.localeCompare(right.label));
}

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

function score(candidate: SettingsSearchEntry, query: string): number {
  const label = normalize(candidate.label);
  if (label === query) return 3;
  if (label.startsWith(query)) return 2;
  if (label.includes(query)) return 1;
  return 0;
}

interface PackageField {
  key: string;
  label: string;
  description: string;
  target?: string;
  inline?: boolean;
}

function packageFields(settings: PackageSettingsReadModel | undefined): PackageField[] {
  if (!settings) return [];
  if (settings.kind === "generic") {
    return settings.fields.map(field => ({
      key: field.key,
      label: field.label,
      description: field.description ?? `Applies ${field.apply.replace("-", " ")}.`,
      inline: field.type !== "prompt",
    }));
  }

  const model = (label = "Model", description = "Choose the model used by this package."): PackageField => ({
    key: "model",
    label,
    description,
  });
  switch (settings.kind) {
    case "timeline":
      return [
        model("Timeline titles", "Generate semantic checkpoint and session titles."),
        { key: "prompt", label: "Timeline naming instructions", description: "Customize session and checkpoint naming prompts.", inline: false },
        { key: "git-timeout", label: "Git timeout", description: "Maximum time for each Timeline git operation." },
        { key: "title-timeout", label: "Title generation timeout", description: "Maximum time for each title call." },
        { key: "title-output", label: "Title maximum output", description: "Maximum tokens generated for a Timeline title." },
        { key: "changed-files", label: "Changed files in title prompt", description: "Maximum changed-file paths supplied to title generation." },
        { key: "rollback", label: "Rollback files when editing prompts", description: "Restore the matching checkpoint when an earlier prompt is edited." },
      ];
    case "advisor":
      return [
        model(),
        { key: "thinking", label: "Thinking", description: "Choose the Advisor thinking level." },
        { key: "prompt", label: "Advisor system prompt", description: "Customize the package-owned prompt.", inline: false },
        { key: "max-calls", label: "Maximum consultations", description: "Maximum Advisor calls for each user prompt." },
        { key: "timeout", label: "Consultation timeout", description: "Stops an Advisor consultation after this duration." },
        { key: "cost", label: "Maximum consultation cost", description: "Stops a consultation at this cost limit." },
        { key: "output", label: "Maximum output tokens", description: "Caps each Advisor response." },
        { key: "input", label: "Input context budget", description: "Caps the Advisor snapshot input token budget." },
      ];
    case "scout":
      return [
        model(),
        { key: "thinking", label: "Thinking", description: "Choose the Scout thinking level." },
        { key: "prompt", label: "Scout system prompt", description: "Customize the package-owned prompt.", inline: false },
        { key: "timeout", label: "Repository scout timeout", description: "Stops a repository scout run after this duration." },
        { key: "cost", label: "Maximum scout cost", description: "Set the repository scout cost limit." },
        { key: "results", label: "Web search results", description: "Default URL candidates returned by Web Scout." },
        { key: "web-search", label: "OpenAI / Exa search for Web Scout", description: "Enable optional Web Scout search." },
      ];
    case "grunt":
      return [
        model(),
        { key: "thinking", label: "Eligible thinking levels", description: "Thinking levels a grunt run may use." },
        { key: "prompt", label: "Grunt system prompt", description: "Customize the selected worker-mode prompt.", inline: false },
        { key: "mode", label: "Execution mode", description: "Choose isolated, direct, or dynamic execution." },
        { key: "timeout", label: "Worker timeout", description: "Stops a worker run after this duration." },
        { key: "turns", label: "Maximum tool-call turns", description: "Maximum tool calls in one worker run." },
        { key: "cost", label: "Maximum worker cost", description: "Stops a worker run at this cost limit." },
        { key: "context", label: "Parent context", description: "Parent-session context included in worker handoffs." },
      ];
    case "continuity":
      return [
        { key: "memory", label: "Durable memory", description: "Keep project notes and papercuts across sessions." },
        { key: "reserve", label: "Automatic compaction reserve", description: "Remaining context tokens that trigger compaction." },
        { key: "retained", label: "Continuity retained tokens", description: "Recent raw history retained after compaction." },
        { key: "review-timeout", label: "Compaction review timeout", description: "Maximum time for a compaction reviewer call." },
        { key: "review-output", label: "Compaction reviewer maximum output", description: "Maximum tokens generated by the compaction reviewer." },
        { key: "planner", label: "Planner", description: "Model profile that breaks a goal into tasks." },
        { key: "executor", label: "Executor", description: "Model profile that carries out tasks." },
        { key: "memory-reviewer", label: "Memory reviewer", description: "Model profile that approves memories." },
        { key: "compaction-reviewer", label: "Compaction reviewer", description: "Model profile that checks compaction summaries." },
        { key: "prompt", label: "Continuity reviewer instructions", description: "Customize memory review and migration prompts.", inline: false },
      ];
    case "sieve":
      return [
        { key: "active", label: "Active pruning", description: "Remove stale tool results from context." },
        { key: "mode", label: "Projection mode", description: "Choose the context projection algorithm." },
        { key: "threshold", label: "Pruning threshold", description: "Minimum result size eligible for pruning." },
        { key: "high", label: "High multiplier", description: "Threshold multiple that begins rollover.", target: settings.projectionMode === "stable" ? undefined : "Projection mode", inline: settings.projectionMode === "stable" },
        { key: "target", label: "Target multiplier", description: "Threshold multiple that ends rollover.", target: settings.projectionMode === "stable" ? undefined : "Projection mode", inline: settings.projectionMode === "stable" },
      ];
    case "spawn":
      return [
        { key: "all-models", label: "All available models", description: "Let private agents use every visible model." },
        { key: "models", label: "Eligible models", description: "Models a private agent may use." },
        { key: "thinking", label: "Private-agent thinking", description: "Thinking levels a private agent may use." },
        { key: "prompt", label: "Private-agent default system prompt", description: "Default prompt for a new private agent.", inline: false },
        { key: "timeout", label: "Spawn timeout", description: "Maximum child runtime." },
        { key: "recent-limit", label: "Recent thread message limit", description: "Default transcript message count returned by recent." },
        { key: "recent-message", label: "Recent thread message characters", description: "Maximum characters per returned transcript message." },
        { key: "recent-total", label: "Recent thread total characters", description: "Maximum total characters returned by recent." },
      ];
  }
  return [];
}
