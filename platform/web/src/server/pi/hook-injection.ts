import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { HookReadModel, HookSettingsReadModel } from "../../shared/protocol/snapshots.ts";
import { cloneHookSettings } from "./hook-settings.ts";

export const SESSION_START_HOOK_CUSTOM_TYPE = "pylon-session-start-hook";

export function formatHookSources(hook: HookReadModel, hookName: "sessionStart" | "beforeAgentStart" | "sessionCompact"): string | undefined {
  if (!hook.enabled || !hook.sources.length) return undefined;
  const sources = hook.sources.map((source) =>
    `<hook-source hook=${JSON.stringify(hookName)} id=${JSON.stringify(source.id)} name=${JSON.stringify(source.name)} kind=${JSON.stringify(source.kind)}>\n${source.content}\n</hook-source>`,
  );
  return `<pylon-hook hook=${JSON.stringify(hookName)}>\n${sources.join("\n\n")}\n</pylon-hook>`;
}

function branchHasSessionStartMessage(branch: unknown[]): boolean {
  return branch.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as { type?: unknown; customType?: unknown; message?: { customType?: unknown } };
    return item.type === "custom_message"
      && (item.customType === SESSION_START_HOOK_CUSTOM_TYPE || item.message?.customType === SESSION_START_HOOK_CUSTOM_TYPE);
  });
}

function branchHasCompactionReinjection(branch: unknown[], compactionEntryId: string): boolean {
  return branch.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as {
      type?: unknown;
      customType?: unknown;
      details?: { compactionEntryId?: unknown };
      message?: { customType?: unknown; details?: { compactionEntryId?: unknown } };
    };
    return item.type === "custom_message"
      && (item.customType === SESSION_START_HOOK_CUSTOM_TYPE || item.message?.customType === SESSION_START_HOOK_CUSTOM_TYPE)
      && (item.details?.compactionEntryId === compactionEntryId || item.message?.details?.compactionEntryId === compactionEntryId);
  });
}

function compactionContent(settings: HookSettingsReadModel): string | undefined {
  return formatHookSources({
    ...settings.sessionStart,
    sources: settings.sessionStart.sources.filter((source) => source.reinjectOnCompaction === true),
  }, "sessionCompact");
}

/** Always-loaded bridge: settings can change without rebuilding the selected runtime. */
export class HookInjectionBridge {
  private settings: HookSettingsReadModel;

  constructor(settings: HookSettingsReadModel) {
    this.settings = cloneHookSettings(settings);
  }

  update(settings: HookSettingsReadModel): void {
    this.settings = cloneHookSettings(settings);
  }

  readonly extension: InlineExtension = {
    name: "pylon-hook-injection",
    hidden: true,
    factory: (pi) => {
      const unsubscribe = pi.events.on("pylon:spawn-hooks-request", (value) => {
        const request = value as { version?: unknown; provide?: unknown };
        if (request?.version !== 1 || typeof request.provide !== "function") return;
        const sessionStart = formatHookSources(this.settings.sessionStart, "sessionStart");
        const sessionCompact = compactionContent(this.settings);
        const beforeAgentStart = formatHookSources(this.settings.beforeAgentStart, "beforeAgentStart");
        request.provide({
          ...(sessionStart ? { sessionStart: { customType: SESSION_START_HOOK_CUSTOM_TYPE, content: sessionStart } } : {}),
          ...(sessionCompact ? { sessionCompact: { customType: SESSION_START_HOOK_CUSTOM_TYPE, content: sessionCompact } } : {}),
          ...(beforeAgentStart ? { beforeAgentStart } : {}),
        });
      });
      pi.on("session_shutdown", unsubscribe);
      pi.on("session_start", (_event, ctx) => {
        if (process.env.PI_SPAWN_CHILD === "session") return;
        const content = formatHookSources(this.settings.sessionStart, "sessionStart");
        if (!content || branchHasSessionStartMessage(ctx.sessionManager.getBranch())) return;
        // No trigger: persist hidden session context without starting an agent turn.
        pi.sendMessage({ customType: SESSION_START_HOOK_CUSTOM_TYPE, content, display: false });
      });
      pi.on("session_compact", (event, ctx) => {
        if (process.env.PI_SPAWN_CHILD === "session") return;
        const compactionEntryId = event.compactionEntry?.id;
        const content = compactionContent(this.settings);
        if (!compactionEntryId || !content || branchHasCompactionReinjection(ctx.sessionManager.getBranch(), compactionEntryId)) return;
        // No trigger: restore selected durable instructions after the compacted checkpoint.
        pi.sendMessage({
          customType: SESSION_START_HOOK_CUSTOM_TYPE,
          content,
          display: false,
          details: { version: 1, compactionEntryId },
        });
      });
      pi.on("before_agent_start", (event) => {
        if (process.env.PI_SPAWN_CHILD === "session") return;
        const content = formatHookSources(this.settings.beforeAgentStart, "beforeAgentStart");
        if (!content) return;
        return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
      });
    },
  };
}
