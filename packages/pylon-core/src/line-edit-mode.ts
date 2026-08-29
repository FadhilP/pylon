import {
  createEditToolDefinition,
  createReadToolDefinition,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { defaultConfig, loadConfig } from "./config.ts";
import { registerLineEditTools } from "./line-edit.ts";

/**
 * Numbered line edits pay for themselves only when output tokens are expensive relative to input.
 * Models with unknown or missing pricing are treated as expensive.
 */
function modelUsesNumberedLineEdits(model: any): boolean {
  const rates = model?.cost ? [model.cost, ...(Array.isArray(model.cost.tiers) ? model.cost.tiers : [])] : [];
  if (!rates.length) return true;
  return rates.some(
    rate =>
      !Number.isFinite(rate?.input) ||
      rate.input <= 0 ||
      !Number.isFinite(rate?.output) ||
      rate.output <= 0 ||
      rate.output / rate.input >= 3,
  );
}

/** Swaps the read/edit tool pair between Pi's native tools and Pylon's numbered-line variants. */
export function createLineEditMode(pi: ExtensionAPI) {
  let mode: "native" | "numbered" = "native";
  let overridden = false;
  let configError: string | undefined;
  const config = loadConfig().catch(error => {
    configError = error instanceof Error ? error.message : String(error);
    return defaultConfig();
  });

  const apply = (next: "native" | "numbered", cwd: string, sessionStart: boolean) => {
    if (!sessionStart && next === mode) return;
    if (next === "native" && !overridden) {
      mode = next;
      return;
    }
    if (next === "numbered") registerLineEditTools(pi);
    else {
      const autoResizeImages = SettingsManager.create(cwd).getImageAutoResize();
      pi.registerTool(createReadToolDefinition(cwd, { autoResizeImages }));
      pi.registerTool(createEditToolDefinition(cwd));
    }
    overridden = true;
    mode = next;
  };

  return {
    get mode() {
      return mode;
    },
    get configError() {
      return configError;
    },
    async update(model: any, cwd: string, sessionStart = false) {
      const resolved = await config;
      apply(resolved.lineEditEnabled && modelUsesNumberedLineEdits(model) ? "numbered" : "native", cwd, sessionStart);
    },
  };
}
