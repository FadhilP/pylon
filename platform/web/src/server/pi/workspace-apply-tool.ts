import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface WorkspaceApplyToolInfo {
  available: boolean;
  reason?: string;
  targetBranch?: string;
  changedCount?: number;
  revision?: string;
  mode?: "checkout" | "worktree";
}

type Handler = (request: { type: "inspect" } | { type: "schedule"; revision: string }) =>
  Promise<WorkspaceApplyToolInfo | void>;

export class WorkspaceApplyTool {
  private handler?: Handler;
  private result?: string;

  readonly extension: InlineExtension = {
    name: "pylon-web-workspace-apply",
    hidden: true,
    factory: (pi) => {
      const bridge = this;
      pi.on("session_start", () => {
        let coordinated = false;
        pi.events.emit("pylon:tool-policy", {
          version: 1,
          kind: "register",
          owner: "pylon-core",
          managedTools: ["apply_session_changes"],
          enabledTools: ["apply_session_changes"],
          deferredTools: ["apply_session_changes"],
          deferredToolUsage: { apply_session_changes: "apply this session's changes to the registered project's current branch after explicit user approval" },
          acknowledge: () => { coordinated = true; },
        });
        if (!coordinated) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "apply_session_changes"));
      });
      pi.on("session_shutdown", () => {
        pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pylon-core" });
      });
      pi.on("before_agent_start", () => {
        if (!bridge.result) return;
        const content = bridge.result;
        bridge.result = undefined;
        return {
          message: {
            customType: "pylon-workspace-apply-result",
            display: false,
            content,
          },
        };
      });
      pi.registerTool({
        name: "apply_session_changes",
        label: "Apply session changes",
        description: "Request applying this session's changes to the registered project's current branch only when the user explicitly asks. Requires confirmation and runs after the current turn settles. Make this the final workspace-mutating tool call of the turn and do not modify workspace files afterward.",
        promptSnippet: "Apply this session's changes to the original project branch after approval",
        promptGuidelines: [
          "Call apply_session_changes only after the user explicitly requests applying this session to their original project branch. Make it the final workspace-mutating tool call of the turn.",
        ],
        parameters: { type: "object", properties: {}, additionalProperties: false } as any,
        async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
          const info = await bridge.handler?.({ type: "inspect" }) as WorkspaceApplyToolInfo | undefined;
          if (!info?.available || !info.revision || !info.targetBranch) {
            const reason = info?.reason ?? "The web workspace host is unavailable.";
            return { content: [{ type: "text" as const, text: `Session changes were not scheduled: ${reason}` }] };
          }
          if (!ctx.hasUI) {
            return { content: [{ type: "text" as const, text: "Session changes were not scheduled because confirmation UI is unavailable." }] };
          }
          const behavior = info.mode === "checkout"
            ? "The session will continue locally on that branch."
            : "The session will remain isolated.";
          const approved = await ctx.ui.confirm(
            "Apply session changes?",
            `Apply ${info.changedCount ?? 0} changed files to ${info.targetBranch} as uncommitted working-tree changes? ${behavior}`,
          );
          if (!approved) {
            return { content: [{ type: "text" as const, text: "The user declined applying session changes." }] };
          }
          await bridge.handler?.({ type: "schedule", revision: info.revision });
          return {
            content: [{
              type: "text" as const,
              text: `Application to ${info.targetBranch} is scheduled after this turn settles. Do not modify workspace files after this tool call.`,
            }],
          };
        },
      } as any);
    },
  };

  setHandler(handler: Handler): void {
    this.handler = handler;
  }

  recordResult(result: string): void {
    this.result = result.slice(0, 32 * 1024);
  }
}
