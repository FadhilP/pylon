import { useState } from "react";
import type { SettingsTab } from "./settings-dialog";

/** Which tab the settings dialog opens on, and what it pre-filters there. */
export interface SettingsDialogState {
  tab: SettingsTab;
  providerQuery: string;
  packageQuery: string;
}

/**
 * The settings dialog opens from several places, each wanting a different tab and
 * filter. Keeping one optional state makes "open" derived rather than a second
 * source of truth that can disagree with the tab.
 */
export function useSettingsDialog() {
  const [settings, setSettings] = useState<SettingsDialogState>();

  const openSettings = (options: Partial<SettingsDialogState> = {}) =>
    setSettings({
      tab: options.tab ?? "packages",
      providerQuery: options.providerQuery ?? "",
      packageQuery: options.packageQuery ?? "",
    });

  return { settings, settingsOpen: Boolean(settings), openSettings, closeSettings: () => setSettings(undefined) };
}
