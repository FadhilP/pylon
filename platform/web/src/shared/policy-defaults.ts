import { DEFAULT_GUARD_RULES, type EffectiveGuardRules } from "./guard-policy.ts";
import type { DialogTimeoutSeconds, ToolOverrideReadModel, WorkspacePolicyMode } from "./protocol/snapshots.ts";

/** How long a guard or clarify dialog waits before it times out. */
export const DEFAULT_DIALOG_TIMEOUT_SECONDS = 60;

/* The read model leaves guardRules and toolOverrides optional because a
   project or session layer may omit them. The global layer always carries
   both, so the defaults are typed with them required. */
export interface GlobalPolicyDefaults {
  timelineEnabled: boolean;
  guardEnabled: boolean;
  guardRules: EffectiveGuardRules;
  workspace: WorkspacePolicyMode;
  guardTimeoutSeconds: DialogTimeoutSeconds;
  clarifyTimeoutSeconds: DialogTimeoutSeconds;
  toolOverrides: ToolOverrideReadModel;
}

/* The global policy a fresh install starts from. It lives here rather than
   inside the registry so the settings dialog can tell an unchanged setting
   from one you chose, and put a changed one back. */
export function defaultGlobalPolicy(): GlobalPolicyDefaults {
  return {
    timelineEnabled: true,
    guardEnabled: true,
    guardRules: { ...DEFAULT_GUARD_RULES },
    workspace: "local",
    guardTimeoutSeconds: DEFAULT_DIALOG_TIMEOUT_SECONDS,
    clarifyTimeoutSeconds: DEFAULT_DIALOG_TIMEOUT_SECONDS,
    toolOverrides: {},
  };
}
