import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Changes to risk meaning invalidate remembered approvals.
export const POLICY_VERSION = 2;

export const GUARD_ACTIONS = ["allow", "confirm", "block"] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

export const GUARD_RISK_CATEGORIES = {
  COMMAND_PRIVILEGE_ESCALATION: "command.privilege-escalation",
  COMMAND_RECURSIVE_DELETION: "command.recursive-deletion",
  COMMAND_DESTRUCTIVE_GIT_RESET: "command.destructive-git-reset",
  COMMAND_DESTRUCTIVE_GIT_CLEAN: "command.destructive-git-clean",
  COMMAND_FORCED_GIT_PUSH: "command.forced-git-push",
  COMMAND_DISK_MODIFICATION: "command.disk-modification",
  COMMAND_RAW_DEVICE_WRITE: "command.raw-device-write",
  COMMAND_RECURSIVE_PERMISSION_CHANGE: "command.recursive-permission-change",
  PATH_GIT_INTERNALS: "path.git-internals",
  PATH_NODE_MODULES: "path.node-modules",
  PATH_OUTSIDE_WORKSPACE: "path.outside-workspace",
  PATH_WORKSPACE_ESCAPE: "path.workspace-escape",
  PATH_ENVIRONMENT_FILE: "path.environment-file",
} as const;
export type GuardRiskCategory = (typeof GUARD_RISK_CATEGORIES)[keyof typeof GUARD_RISK_CATEGORIES];

export type GuardRules = Partial<Record<GuardRiskCategory, GuardAction>>;
export type EffectiveGuardRules = Record<GuardRiskCategory, GuardAction>;

export const DEFAULT_GUARD_RULES: EffectiveGuardRules = {
  [GUARD_RISK_CATEGORIES.COMMAND_PRIVILEGE_ESCALATION]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_DELETION]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_DESTRUCTIVE_GIT_RESET]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_DESTRUCTIVE_GIT_CLEAN]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_FORCED_GIT_PUSH]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_DISK_MODIFICATION]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_RAW_DEVICE_WRITE]: "confirm",
  [GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_PERMISSION_CHANGE]: "confirm",
  [GUARD_RISK_CATEGORIES.PATH_GIT_INTERNALS]: "block",
  [GUARD_RISK_CATEGORIES.PATH_NODE_MODULES]: "block",
  [GUARD_RISK_CATEGORIES.PATH_OUTSIDE_WORKSPACE]: "confirm",
  [GUARD_RISK_CATEGORIES.PATH_WORKSPACE_ESCAPE]: "block",
  [GUARD_RISK_CATEGORIES.PATH_ENVIRONMENT_FILE]: "confirm",
};

export const BLOCK_GUARD_RULES: EffectiveGuardRules = Object.fromEntries(
  Object.values(GUARD_RISK_CATEGORIES).map(category => [category, "block"]),
) as EffectiveGuardRules;

const categories = new Set<string>(Object.values(GUARD_RISK_CATEGORIES));
const actions = new Set<string>(GUARD_ACTIONS);

/** Validates the sparse `guardRules` payload from `pylon:runtime-policy` v2. */
export function validateGuardRules(value: unknown): GuardRules | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rules: GuardRules = {};
  for (const [category, action] of Object.entries(value)) {
    if (!categories.has(category) || typeof action !== "string" || !actions.has(action)) return undefined;
    rules[category as GuardRiskCategory] = action as GuardAction;
  }
  return rules;
}

export function mergeGuardRules(overrides: GuardRules = {}): EffectiveGuardRules {
  return { ...DEFAULT_GUARD_RULES, ...overrides };
}

export type GuardRisk = { category: GuardRiskCategory; reason: string; target?: string };

const commandRules: Array<[RegExp, GuardRiskCategory, string]> = [
  [/\b(?:sudo|doas)\b/i, GUARD_RISK_CATEGORIES.COMMAND_PRIVILEGE_ESCALATION, "privilege escalation"],
  [
    /\brm\b[^\n;&|]*(?:--recursive|-[a-z]*r[a-z]*)/i,
    GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_DELETION,
    "recursive deletion",
  ],
  [
    /\b(?:rmdir|rd)\b[^\n;&|]*\/(?:s|q)\b/i,
    GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_DELETION,
    "recursive directory deletion",
  ],
  [/\b(?:del|erase)\b[^\n;&|]*\/s\b/i, GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_DELETION, "recursive deletion"],
  [
    /\bRemove-Item\b[^\n;|]*-(?:Recurse|Force)\b/i,
    GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_DELETION,
    "recursive or forced deletion",
  ],
  [/\bgit\s+reset\s+--hard\b/i, GUARD_RISK_CATEGORIES.COMMAND_DESTRUCTIVE_GIT_RESET, "destructive Git reset"],
  [/\bgit\s+clean\s+-[a-z]*f/i, GUARD_RISK_CATEGORIES.COMMAND_DESTRUCTIVE_GIT_CLEAN, "destructive Git clean"],
  [
    /\bgit\s+push\b[^\n;&|]*\s(?:-f|--force(?:-with-lease)?)\b/i,
    GUARD_RISK_CATEGORIES.COMMAND_FORCED_GIT_PUSH,
    "forced Git push",
  ],
  [/\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, GUARD_RISK_CATEGORIES.COMMAND_DISK_MODIFICATION, "disk modification"],
  [
    /\bdd\b[^\n;&|]*\bof=\s*(?:\/dev\/|\\\\\.\\PhysicalDrive)/i,
    GUARD_RISK_CATEGORIES.COMMAND_RAW_DEVICE_WRITE,
    "raw device write",
  ],
  [
    /\b(?:chmod|chown)\b[^\n;&|]*\s-R\b/i,
    GUARD_RISK_CATEGORIES.COMMAND_RECURSIVE_PERMISSION_CHANGE,
    "recursive permission change",
  ],
];

function risk(category: GuardRiskCategory, reason: string, target?: string): GuardRisk {
  return { category, reason, ...(target ? { target } : {}) };
}

export function commandRisk(command: string): GuardRisk | undefined {
  const match = commandRules.find(([pattern]) => pattern.test(command));
  return match && risk(match[1], match[2]);
}

/** Bash treats bare `nul` as a normal file, including on Windows. */
export function hasBashNulRedirect(command: string): boolean {
  return /(?<!>)(?:\d+|&)?(?:>>?|>\|)\s*(?:"nul"|'nul'|nul)(?=$|[\s;|&)])/i.test(command);
}

function missingPath(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function canonicalTarget(cwd: string, input: string) {
  const target = resolve(cwd, input.replace(/^@/, ""));
  try {
    return await realpath(target);
  } catch (error) {
    if (!missingPath(error)) throw error;
    let parent = dirname(target);
    const suffix: string[] = [target.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))];
    for (;;) {
      try {
        // Copy before reversing: `suffix` keeps growing if this attempt throws.
        return resolve(await realpath(parent), ...[...suffix].reverse());
      } catch (parentError) {
        if (!missingPath(parentError)) throw parentError;
        const next = dirname(parent);
        if (next === parent) return target;
        suffix.push(parent.slice(next.length + (next.endsWith(sep) ? 0 : 1)));
        parent = next;
      }
    }
  }
}

function outside(root: string, target: string) {
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function explicitAbsolute(input: string) {
  const value = input.replace(/^@/, "");
  if (!isAbsolute(value)) return false;
  if (process.platform !== "win32") return value.startsWith("/");
  return /^[a-z]:[\\/]/i.test(value);
}

export async function pathRisk(cwd: string, input: string): Promise<GuardRisk | undefined> {
  const root = await realpath(cwd);
  const lexicalTarget = resolve(cwd, input.replace(/^@/, ""));
  const target = await canonicalTarget(cwd, input);
  const segments = target.split(/[\\/]/).map(part => part.toLowerCase());
  if (segments.includes(".git"))
    return risk(GUARD_RISK_CATEGORIES.PATH_GIT_INTERNALS, ".git internals are protected", target);
  if (segments.includes("node_modules"))
    return risk(GUARD_RISK_CATEGORIES.PATH_NODE_MODULES, "node_modules is generated and protected", target);
  if (outside(root, target)) {
    if (explicitAbsolute(input) && outside(resolve(cwd), lexicalTarget))
      return risk(GUARD_RISK_CATEGORIES.PATH_OUTSIDE_WORKSPACE, "write target is outside workspace", target);
    return risk(GUARD_RISK_CATEGORIES.PATH_WORKSPACE_ESCAPE, "write target escapes workspace", target);
  }
  if (segments.some(part => part === ".env" || part.startsWith(".env.")))
    return risk(GUARD_RISK_CATEGORIES.PATH_ENVIRONMENT_FILE, "environment file may contain secrets", target);
  return undefined;
}
