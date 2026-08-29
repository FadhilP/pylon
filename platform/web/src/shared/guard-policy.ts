export const GUARD_ACTIONS = ["allow", "confirm", "block"] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

export const GUARD_RISK_CATEGORIES = [
  "command.privilege-escalation",
  "command.recursive-deletion",
  "command.destructive-git-reset",
  "command.destructive-git-clean",
  "command.forced-git-push",
  "command.disk-modification",
  "command.raw-device-write",
  "command.recursive-permission-change",
  "path.git-internals",
  "path.node-modules",
  "path.outside-workspace",
  "path.workspace-escape",
  "path.environment-file",
] as const;
export type GuardRiskCategory = (typeof GUARD_RISK_CATEGORIES)[number];
export type GuardRuleOverrides = Partial<Record<GuardRiskCategory, GuardAction>>;
export type EffectiveGuardRules = Record<GuardRiskCategory, GuardAction>;

export const DEFAULT_GUARD_RULES: EffectiveGuardRules = {
  "command.privilege-escalation": "confirm",
  "command.recursive-deletion": "confirm",
  "command.destructive-git-reset": "confirm",
  "command.destructive-git-clean": "confirm",
  "command.forced-git-push": "confirm",
  "command.disk-modification": "confirm",
  "command.raw-device-write": "confirm",
  "command.recursive-permission-change": "confirm",
  "path.git-internals": "block",
  "path.node-modules": "block",
  "path.outside-workspace": "confirm",
  "path.workspace-escape": "block",
  "path.environment-file": "confirm",
};

const categorySet = new Set<string>(GUARD_RISK_CATEGORIES);
const actionSet = new Set<string>(GUARD_ACTIONS);

export function validGuardRules(value: unknown, complete = false): value is GuardRuleOverrides | EffectiveGuardRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (complete && entries.length !== GUARD_RISK_CATEGORIES.length) return false;
  return entries.every(
    ([category, action]) => categorySet.has(category) && typeof action === "string" && actionSet.has(action),
  );
}

export function mergeGuardRules(...rules: GuardRuleOverrides[]): EffectiveGuardRules {
  return Object.assign({}, DEFAULT_GUARD_RULES, ...rules);
}

export type GuardRuleSource = "Global" | "Project" | "This session";

export function resolveGuardRule(
  category: GuardRiskCategory,
  global: GuardRuleOverrides,
  project: GuardRuleOverrides = {},
  session: GuardRuleOverrides = {},
): { value: GuardAction; source: GuardRuleSource } {
  if (session[category]) return { value: session[category], source: "This session" };
  if (project[category]) return { value: project[category], source: "Project" };
  return { value: global[category] ?? DEFAULT_GUARD_RULES[category], source: "Global" };
}

export const GUARD_RULE_LABELS: Record<GuardRiskCategory, string> = {
  "command.privilege-escalation": "Privilege escalation",
  "command.recursive-deletion": "Recursive deletion",
  "command.destructive-git-reset": "Destructive Git reset",
  "command.destructive-git-clean": "Destructive Git clean",
  "command.forced-git-push": "Forced Git push",
  "command.disk-modification": "Disk modification",
  "command.raw-device-write": "Raw device write",
  "command.recursive-permission-change": "Recursive permission change",
  "path.git-internals": ".git internals",
  "path.node-modules": "node_modules writes",
  "path.outside-workspace": "Writes outside workspace",
  "path.workspace-escape": "Workspace path escape",
  "path.environment-file": "Environment files",
};

export const GUARD_RULE_DESCRIPTIONS: Record<GuardRiskCategory, string> = {
  "command.privilege-escalation": "Commands that request elevated privileges.",
  "command.recursive-deletion": "Recursive file or directory removal.",
  "command.destructive-git-reset": "Git resets that discard working changes.",
  "command.destructive-git-clean": "Git clean commands that remove untracked files.",
  "command.forced-git-push": "Pushes that can rewrite remote history.",
  "command.disk-modification": "Commands that modify disks or partitions.",
  "command.raw-device-write": "Direct writes to block or character devices.",
  "command.recursive-permission-change": "Recursive ownership or permission changes.",
  "path.git-internals": "Writes inside the repository’s .git directory.",
  "path.node-modules": "Writes inside dependency installation directories.",
  "path.outside-workspace": "Writes to resolved paths outside the workspace.",
  "path.workspace-escape": "Paths that escape the workspace during resolution.",
  "path.environment-file": "Writes to files that commonly contain secrets.",
};
