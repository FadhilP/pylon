import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const MANAGED_TOOLS = ["apply_session_changes", "pylon_docs", "pylon_settings"];

/** Groups Pylon Web host tools under the single pylon-core policy owner. */
export const pylonCoreWebTools: InlineExtension = {
  name: "pylon-core-web-tools",
  hidden: true,
  factory: pi => {
    pi.on("session_start", () => {
      pi.events.emit("pylon:host-context", { version: 1, host: "web" });
      let coordinated = false;
      pi.events.emit("pylon:tool-policy", {
        version: 1,
        kind: "register",
        owner: "pylon-core",
        managedTools: MANAGED_TOOLS,
        enabledTools: MANAGED_TOOLS,
        deferredTools: MANAGED_TOOLS,
        toolUsage: {
          apply_session_changes:
            "apply this session's changes to the registered project's current branch after explicit user approval",
          pylon_docs: "read shipped Pylon and Pylon Web documentation for product-specific questions",
          pylon_settings: "inspect or update validated Pylon package settings after explicit user confirmation",
        },
        acknowledge: () => {
          coordinated = true;
        },
      });
      if (!coordinated) {
        pi.setActiveTools(pi.getActiveTools().filter(name => !MANAGED_TOOLS.includes(name)));
      }
    });
    pi.on("session_shutdown", () => {
      pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pylon-core" });
    });
  },
};
