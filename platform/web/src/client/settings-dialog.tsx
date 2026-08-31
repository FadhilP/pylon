import {
  IconBell,
  IconAlertTriangle,
  IconContrast,
  IconExternalLink,
  IconKey,
  IconLogout,
  IconPackages,
  IconPlugConnected,
  IconPuzzle,
  IconSettings,
  IconShield,
  IconStack2,
  IconWebhook,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_GUARD_RULES,
  GUARD_ACTIONS,
  GUARD_RISK_CATEGORIES,
  GUARD_RULE_DESCRIPTIONS,
  GUARD_RULE_LABELS,
} from "../shared/guard-policy";
import type {
  ModelOptionReadModel,
  ProviderAuthReadModel,
  ProviderAuthType,
  ThinkingLevelReadModel,
  ToolPolicyReadModel,
  UiRequestReadModel,
} from "../shared/protocol/events";
import type { HeliosAndroidToolingResult } from "../shared/protocol/helios-android-tooling";
import type {
  ExtensionListSnapshot,
  HookSettingsReadModel,
  NativeExtensionReadModel,
  PackageSettingsReadModel,
  PackageSummary,
  RuntimePolicyReadModel,
  ToolExposureMode,
} from "../shared/protocol/snapshots";
import { SYNTAX_THEMES, type SyntaxTheme } from "../shared/syntax-highlighting";
import { thinkingLabel } from "./format";
import { ExtensionSettingsFields } from "./extension-settings-fields";
import { HookSettingsFields } from "./hook-settings-fields";
import { RuntimePolicyTimeoutControl } from "./runtime-policy-timeout";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";
import { UiDialog } from "./ui-dialog";
import { modelKey, setHiddenModelVisible, useHiddenModels, visibleModels } from "./model-visibility";
import { OverviewOrb, type OverviewState } from "./overview-primitives";

export type SettingsTab =
  "providers" | "models" | "packages" | "extensions" | "hooks" | "policy" | "notifications" | "appearance";
type SettingsTheme = "light" | "dark";
/* Grouping the eight sections names the thing each one governs; the flat order
   below stays the roving-tabindex order, so it must match the visual order. */
const SETTINGS_NAV: { group: string; tabs: { tab: SettingsTab; label: string; icon: ReactNode }[] }[] = [
  {
    group: "Accounts",
    tabs: [
      { tab: "providers", label: "Providers", icon: <IconPlugConnected size={15} /> },
      { tab: "models", label: "Models", icon: <IconStack2 size={15} /> },
    ],
  },
  {
    group: "Capabilities",
    tabs: [
      { tab: "packages", label: "Packages", icon: <IconPackages size={15} /> },
      { tab: "extensions", label: "Extensions", icon: <IconPuzzle size={15} /> },
      { tab: "hooks", label: "Hooks", icon: <IconWebhook size={15} /> },
    ],
  },
  {
    group: "Behavior",
    tabs: [
      { tab: "policy", label: "Policy", icon: <IconShield size={15} /> },
      { tab: "notifications", label: "Notifications", icon: <IconBell size={15} /> },
    ],
  },
  { group: "Pylon", tabs: [{ tab: "appearance", label: "Appearance", icon: <IconContrast size={15} /> }] },
];
const SETTINGS_TABS: SettingsTab[] = SETTINGS_NAV.flatMap(group => group.tabs.map(entry => entry.tab));
const PACKAGE_THINKING_LEVELS: ThinkingLevelReadModel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
interface SettingsDialogProps {
  initialTab?: SettingsTab;
  initialProviderQuery?: string;
  initialPackageQuery?: string;
  providerAuth?: ProviderAuthReadModel;
  pendingUi?: UiRequestReadModel;
  packages: PackageSummary[];
  projects: { id: string; label: string }[];
  extensions?: ExtensionListSnapshot;
  hookSettings?: HookSettingsReadModel;
  runtimePolicy?: RuntimePolicyReadModel;
  toolPolicies: ToolPolicyReadModel[];
  policyDisabled: boolean;
  loading: boolean;
  extensionLoading: boolean;
  hookLoading: boolean;
  busy: string;
  extensionBusy: boolean;
  hookBusy: boolean;
  androidTooling?: HeliosAndroidToolingResult;
  androidToolingBusy: "" | "install" | "remove";
  providerLogoutDisabled: boolean;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  theme: SettingsTheme;
  onThemeChange: (theme: SettingsTheme) => void;
  syntaxTheme: SyntaxTheme;
  onSyntaxThemeChange: (theme: SyntaxTheme) => void;
  onClose: () => void;
  onProviderLogin: (provider: string, authType: ProviderAuthType) => void;
  onProviderLogout: (provider: string) => void;
  onProviderCancel: () => void;
  onSetEnabled: (item: PackageSummary, enabled: boolean) => void;
  onUpdate: (item: PackageSummary, settings: PackageSettingsReadModel) => void;
  onAndroidTooling: (action: "status" | "install" | "remove") => Promise<void>;
  onToggleExtension: (extension: NativeExtensionReadModel, enabled: boolean) => Promise<void>;
  onInstallExtensionPackage: (source: string, scope: "user" | "project", projectId?: string) => Promise<void>;
  onRemoveExtensionPackage: (source: string, scope: "user" | "project") => Promise<void>;
  onSetProjectTrust: (trusted: boolean) => Promise<void>;
  onReloadExtensions: () => Promise<void>;
  onUpdateHooks: (settings: HookSettingsReadModel) => Promise<void>;
  onUpdateGlobalPolicy: (settings: RuntimePolicyReadModel["global"], expectedRevision: number) => Promise<void>;
  onUpdateGlobalToolPolicy: (
    tool: string,
    mode: ToolExposureMode | "inherit",
    expectedRevision: number,
  ) => Promise<void>;
}

export function SettingsDialog({
  initialTab = "packages",
  initialProviderQuery = "",
  initialPackageQuery = "",
  providerAuth,
  pendingUi,
  packages,
  projects,
  extensions,
  hookSettings,
  runtimePolicy,
  toolPolicies,
  policyDisabled,
  loading,
  extensionLoading,
  hookLoading,
  busy,
  extensionBusy,
  hookBusy,
  androidTooling,
  androidToolingBusy,
  providerLogoutDisabled,
  models,
  sessionThinkingLevels,
  theme,
  onThemeChange,
  syntaxTheme,
  onSyntaxThemeChange,
  onClose,
  onProviderLogin,
  onProviderLogout,
  onProviderCancel,
  onSetEnabled,
  onUpdate,
  onAndroidTooling,
  onToggleExtension,
  onInstallExtensionPackage,
  onRemoveExtensionPackage,
  onSetProjectTrust,
  onReloadExtensions,
  onUpdateHooks,
  onUpdateGlobalPolicy,
  onUpdateGlobalToolPolicy,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [providerQuery, setProviderQuery] = useState(initialProviderQuery);
  const [packageQuery, setPackageQuery] = useState(initialPackageQuery);
  const [modelQuery, setModelQuery] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [toolPolicyBusy, setToolPolicyBusy] = useState("");
  const filteredPackages = packages.filter(item =>
    `${item.name} ${item.description}`.toLowerCase().includes(packageQuery.trim().toLowerCase()),
  );
  const providers = providerAuth?.providers ?? [];
  const filteredProviders = providers
    .filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const providerGroups = [
    { id: "connected", label: "Connected", providers: filteredProviders.filter(provider => provider.configured) },
    { id: "available", label: "Available", providers: filteredProviders.filter(provider => !provider.configured) },
  ];
  const hiddenModelKeys = useHiddenModels();
  const filteredModels = models.filter(item =>
    `${item.provider} ${item.id} ${item.name}`.toLowerCase().includes(modelQuery.trim().toLowerCase()),
  );
  const modelGroups: { provider: string; items: ModelOptionReadModel[] }[] = [];
  for (const item of filteredModels) {
    const last = modelGroups[modelGroups.length - 1];
    if (last && last.provider === item.provider) last.items.push(item);
    else modelGroups.push({ provider: item.provider, items: [item] });
  }
  const setProviderVisible = (items: ModelOptionReadModel[], visible: boolean) => {
    for (const item of items) setHiddenModelVisible(`${item.provider}/${item.id}`, visible);
  };
  const authFlow = providerAuth?.flow;
  const authRunning = authFlow?.status === "running";
  const providerPrompt = pendingUi?.payload.context === "provider-auth" ? pendingUi : undefined;
  const primaryAuthLink = authFlow?.deviceCode
    ? { url: authFlow.deviceCode.verificationUri, label: "Open verification page" }
    : authFlow?.authUrl
      ? { url: authFlow.authUrl, label: "Open sign-in page" }
      : authFlow?.links?.[0];
  const secondaryAuthLinks =
    authFlow?.links?.filter(
      (link, index, links) =>
        link.url !== primaryAuthLink?.url && links.findIndex(candidate => candidate.url === link.url) === index,
    ) ?? [];
  const authRetryable = authFlow?.status === "failed" || authFlow?.status === "cancelled";

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const playSound = (kind: "turn-complete" | "attention") => {
    unlockWebAudio();
    enqueueWebAudioCues([kind]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      ) ?? []),
    ].filter(element => !element.closest("[hidden]"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % SETTINGS_TABS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SETTINGS_TABS.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(SETTINGS_TABS[next]!);
    dialogRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };

  const hookKeys = ["sessionStart", "beforeAgentStart"] as const;
  const navCounts: Partial<Record<SettingsTab, string>> = {
    providers: providers.length
      ? `${providers.filter(provider => provider.configured).length}/${providers.length}`
      : "",
    models: models.length ? String(models.length) : "",
    packages: packages.length ? String(packages.length) : "",
    extensions: extensions ? String(extensions.extensions.length) : "",
    hooks: hookSettings ? `${hookKeys.filter(key => hookSettings[key].enabled).length}/${hookKeys.length}` : "",
  };
  const isWorkbenchTab = activeTab === "packages" || activeTab === "hooks";

  const selectedPackage = filteredPackages.find(item => item.id === selectedPackageId) ?? filteredPackages[0];
  const selectedToolPolicy = selectedPackage
    ? toolPolicies.find(policy => policy.owner === selectedPackage.id)
    : undefined;
  const selectedTools = selectedToolPolicy?.managedTools ?? [];

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onKeyDown={onKeyDown}>
        <header>
          <div>
            <IconSettings size={18} />
            <strong id="settings-dialog-title">Settings</strong>
            <span>Manage Pylon defaults and integrations</span>
          </div>
          <button data-autofocus className="icon-button" type="button" onClick={onClose} aria-label="Close settings">
            <IconX size={17} />
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <div role="tablist">
              {SETTINGS_NAV.map(group => (
                // Presentational so the tabs stay the tablist's own children.
                <div className="settings-nav-group" role="presentation" key={group.group}>
                  <span className="section-kicker" aria-hidden="true">
                    {group.group}
                  </span>
                  {group.tabs.map(entry => (
                    <button
                      key={entry.tab}
                      id={`settings-tab-${entry.tab}`}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === entry.tab}
                      aria-controls={`settings-panel-${entry.tab}`}
                      tabIndex={activeTab === entry.tab ? 0 : -1}
                      onClick={() => setActiveTab(entry.tab)}
                      onKeyDown={event => onTabKeyDown(event, SETTINGS_TABS.indexOf(entry.tab))}>
                      {entry.icon}
                      {entry.label}
                      {navCounts[entry.tab] && <b>{navCounts[entry.tab]}</b>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <p>
              Settings apply to every project on this machine unless a project or session overrides them.
              <b>Changes save immediately.</b>
            </p>
          </nav>

          <div className={`settings-content${isWorkbenchTab ? " is-workbench" : ""}`}>
            <section
              id="settings-panel-providers"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-providers"
              hidden={activeTab !== "providers"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Providers</h2>
                  <p>Connect accounts and API keys used by Pi. Credentials stay on this machine.</p>
                </div>
                <input
                  type="search"
                  value={providerQuery}
                  onChange={event => setProviderQuery(event.target.value)}
                  placeholder="Filter providers"
                  aria-label="Filter providers"
                />
              </div>
              {(authFlow || providerPrompt) && (
                <section
                  className={`provider-auth-task is-${authFlow?.status ?? "running"}`}
                  aria-labelledby="provider-auth-title">
                  <header>
                    <h3 id="provider-auth-title">{authFlow?.providerName ?? "Provider authentication"}</h3>
                    <p className="provider-auth-status" role={authFlow?.status === "failed" ? "alert" : "status"}>
                      {authFlow?.message ?? "Authentication requires a response."}
                    </p>
                    {authFlow?.instructions && authFlow.instructions !== authFlow.message && (
                      <p className="provider-auth-instructions">{authFlow.instructions}</p>
                    )}
                  </header>
                  <div className="provider-auth-actions">
                    {primaryAuthLink && (
                      <a
                        className="provider-auth-primary"
                        href={primaryAuthLink.url}
                        target="_blank"
                        rel="noopener noreferrer">
                        {primaryAuthLink.label ?? "Open provider page"} <IconExternalLink size={15} />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                    {authRetryable && authFlow && (
                      <button
                        type="button"
                        className="provider-auth-retry"
                        onClick={() => onProviderLogin(authFlow.providerId, authFlow.authType)}>
                        Try again
                      </button>
                    )}
                    {authRunning && (
                      <button type="button" className="provider-auth-cancel" onClick={onProviderCancel}>
                        Cancel
                      </button>
                    )}
                  </div>
                  {authFlow?.deviceCode && (
                    <div className="provider-device-code">
                      <span>One-time code</span>
                      <code>{authFlow.deviceCode.userCode}</code>
                    </div>
                  )}
                  {secondaryAuthLinks.length > 0 && (
                    <div className="provider-auth-links">
                      {secondaryAuthLinks.map(link => (
                        <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
                          {link.label ?? "Open provider page"} <IconExternalLink size={14} />
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ))}
                    </div>
                  )}
                  {providerPrompt && (
                    <div className="provider-auth-manual">
                      <UiDialog request={providerPrompt} />
                    </div>
                  )}
                </section>
              )}
              {providers.length === 0 && (
                <div className="settings-empty">
                  <IconKey size={22} />
                  <strong>No providers available</strong>
                </div>
              )}
              {providers.length > 0 && filteredProviders.length === 0 && (
                <div className="settings-empty">
                  <strong>No matching providers</strong>
                  <span>Try a different filter.</span>
                </div>
              )}
              {filteredProviders.length > 0 && (
                <div className="settings-provider-groups">
                  {providerGroups.map(
                    group =>
                      group.providers.length > 0 && (
                        <section
                          className="settings-provider-group"
                          key={group.id}
                          aria-labelledby={`provider-group-${group.id}`}>
                          <header>
                            <h3 id={`provider-group-${group.id}`}>{group.label}</h3>
                            <span>{group.providers.length}</span>
                          </header>
                          <div className="settings-provider-list">
                            {group.providers.map(provider => (
                              <section className="settings-provider" key={provider.id}>
                                <div className="settings-provider-copy">
                                  <span>
                                    <strong>{provider.name}</strong>
                                    <small>{provider.id}</small>
                                  </span>
                                </div>
                                <span className={`provider-state${provider.configured ? " is-connected" : ""}`}>
                                  {provider.configured ? (provider.stored ? "Connected" : "External") : "Not connected"}
                                </span>
                                <div className="provider-actions">
                                  {!provider.configured &&
                                    provider.methods.map(method =>
                                      method.interactive ? (
                                        <button
                                          key={method.type}
                                          type="button"
                                          disabled={authRunning}
                                          onClick={() => onProviderLogin(provider.id, method.type)}>
                                          {method.type === "oauth" ? "Sign in" : "Add key"}
                                        </button>
                                      ) : (
                                        <span className="provider-action-note" key={method.type} title={method.name}>
                                          Configured outside Pylon
                                        </span>
                                      ),
                                    )}
                                  {provider.configured && provider.stored && (
                                    <button
                                      className="provider-disconnect"
                                      type="button"
                                      disabled={providerLogoutDisabled || authRunning}
                                      onClick={() => onProviderLogout(provider.id)}>
                                      <IconLogout size={14} /> Disconnect
                                    </button>
                                  )}
                                </div>
                              </section>
                            ))}
                          </div>
                        </section>
                      ),
                  )}
                </div>
              )}
              {providerLogoutDisabled && (
                <p className="settings-note" role="status">
                  Providers can disconnect when every active session is idle.
                </p>
              )}
            </section>

            <section
              id="settings-panel-packages"
              className="settings-pane packages-workbench-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-packages"
              hidden={activeTab !== "packages"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Packages</h2>
                  <p>Configure package defaults and global tool exposure from one workbench.</p>
                </div>
                <input
                  type="search"
                  value={packageQuery}
                  onChange={event => setPackageQuery(event.target.value)}
                  placeholder="Filter packages"
                  aria-label="Filter packages"
                />
              </div>
              {loading && packages.length === 0 && <div className="settings-empty">Detecting packages…</div>}
              {!loading && packages.length === 0 && (
                <div className="settings-empty">
                  <IconStack2 size={22} />
                  <strong>No local Pi packages</strong>
                </div>
              )}
              {!loading && packages.length > 0 && filteredPackages.length === 0 && (
                <div className="settings-empty">
                  <strong>No matching packages</strong>
                  <span>Try a different filter.</span>
                </div>
              )}
              {selectedPackage && (
                <div className="package-workbench">
                  <aside className="package-workbench-index" aria-label="Packages">
                    <div className="workbench-index-label">
                      <span>
                        {filteredPackages.length} package{filteredPackages.length === 1 ? "" : "s"}
                      </span>
                      <span>{filteredPackages.filter(item => item.active).length} active</span>
                    </div>
                    {filteredPackages.map(item => {
                      const state = item.error
                        ? "failed"
                        : item.active
                          ? "active"
                          : item.enabled
                            ? "unavailable"
                            : "disabled";
                      const tools = toolPolicies.find(policy => policy.owner === item.id)?.managedTools.length ?? 0;
                      return (
                        <button
                          type="button"
                          aria-selected={item.id === selectedPackage.id}
                          className={item.id === selectedPackage.id ? "is-selected" : ""}
                          onClick={() => setSelectedPackageId(item.id)}
                          key={item.id}>
                          <OverviewOrb state={packageOrbState(state)} label={state} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {tools} tool{tools === 1 ? "" : "s"}
                            </small>
                          </span>
                          {/* The orb already carries "active", and the list header counts
                              them, so only an exception spends a word on its state. */}
                          {state !== "active" && <b className={`package-state is-${state}`}>{state}</b>}
                        </button>
                      );
                    })}
                  </aside>
                  <article className="package-workbench-detail">
                    <header>
                      <div>
                        <h3>{selectedPackage.name}</h3>
                        <p>
                          {selectedPackage.description ||
                            `${selectedPackage.extensionCount} Pi extension${selectedPackage.extensionCount === 1 ? "" : "s"}`}
                        </p>
                      </div>
                      {selectedPackage.required ? (
                        <span className="package-required">Required</span>
                      ) : (
                        <label className="package-switch">
                          <span className="sr-only">Toggle {selectedPackage.name}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={selectedPackage.enabled}
                            disabled={Boolean(busy)}
                            onChange={event => onSetEnabled(selectedPackage, event.target.checked)}
                          />
                        </label>
                      )}
                    </header>
                    {selectedPackage.error && <p className="package-error">{selectedPackage.error}</p>}
                    <section className="workbench-section">
                      <header>
                        <div>
                          <h4>Package defaults</h4>
                          <p>Configuration owned by this package.</p>
                        </div>
                        <span>Global</span>
                      </header>
                      {hasPackageFields(selectedPackage.settings) && selectedPackage.settings ? (
                        <PackageFields
                          settings={selectedPackage.settings}
                          models={models}
                          sessionThinkingLevels={sessionThinkingLevels}
                          disabled={Boolean(busy)}
                          onUpdate={settings => onUpdate(selectedPackage, settings)}
                        />
                      ) : (
                        <p className="workbench-empty">This package has no configurable defaults.</p>
                      )}
                    </section>
                    {selectedPackage.id === "pi-helios" && (
                      <AndroidToolingSettings
                        status={androidTooling}
                        busy={androidToolingBusy}
                        onAction={onAndroidTooling}
                      />
                    )}
                    <section className="workbench-section">
                      <header>
                        <div>
                          <h4>Tool exposure</h4>
                          <p>Defaults used when a project or session does not override them.</p>
                        </div>
                        <span>Global</span>
                      </header>
                      {selectedTools.length ? (
                        <div className="workbench-tool-list">
                          {selectedTools.map(tool => {
                            const capable = selectedToolPolicy?.enabledTools.includes(tool) === true;
                            const packageDefault = selectedToolPolicy?.deferredTools.includes(tool)
                              ? "deferred"
                              : capable
                                ? "active"
                                : "disabled";
                            const override = runtimePolicy?.global.toolOverrides?.[tool];
                            const effective = capable ? (override ?? packageDefault) : "disabled";
                            const locked = tool === "search_tools";
                            const rowClasses = ["workbench-tool-row", override && "is-override", locked && "is-locked"];
                            return (
                              <label
                                className={rowClasses.filter(Boolean).join(" ")}
                                data-effective={effective}
                                key={tool}>
                                <OverviewOrb state={toolOrbState(effective)} label={`Current setting: ${effective}`} />
                                <span>
                                  <strong>{tool}</strong>
                                  <small>{locked ? "always on" : effective}</small>
                                </span>
                                <select
                                  value={override ?? "inherit"}
                                  disabled={
                                    locked || policyDisabled || toolPolicyBusy === tool || (!capable && !override)
                                  }
                                  onChange={event => {
                                    if (!runtimePolicy) return;
                                    const mode = event.target.value as ToolExposureMode | "inherit";
                                    setToolPolicyBusy(tool);
                                    void onUpdateGlobalToolPolicy(tool, mode, runtimePolicy.revision).finally(() =>
                                      setToolPolicyBusy(""),
                                    );
                                  }}>
                                  <option value="inherit">Default</option>
                                  <option value="active" disabled={!capable}>
                                    Active
                                  </option>
                                  <option value="deferred" disabled={!capable}>
                                    Deferred
                                  </option>
                                  <option value="disabled" disabled={!capable}>
                                    Disabled
                                  </option>
                                </select>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="workbench-empty">This package does not publish tool policy.</p>
                      )}
                    </section>
                  </article>
                </div>
              )}
            </section>

            <section
              id="settings-panel-extensions"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-extensions"
              hidden={activeTab !== "extensions"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Extensions</h2>
                  <p>Manage Pi-native extensions and packages in Pylon’s isolated agent directory.</p>
                </div>
              </div>
              <ExtensionSettingsFields
                snapshot={extensions}
                projects={projects}
                loading={extensionLoading}
                disabled={extensionBusy || policyDisabled}
                onToggle={onToggleExtension}
                onInstall={onInstallExtensionPackage}
                onRemove={onRemoveExtensionPackage}
                onTrust={onSetProjectTrust}
                onReload={onReloadExtensions}
              />
            </section>

            <section
              id="settings-panel-hooks"
              className="settings-pane hooks-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-hooks"
              hidden={activeTab !== "hooks"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Hooks</h2>
                  <p>
                    Add workspace instructions at two predictable points in the agent lifecycle. Import Markdown or text
                    snapshots, or write instructions directly.
                  </p>
                </div>
              </div>
              <HookSettingsFields
                settings={hookSettings}
                loading={hookLoading}
                disabled={hookBusy}
                onUpdate={onUpdateHooks}
              />
            </section>

            <section
              id="settings-panel-policy"
              className="settings-pane global-policy-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-policy"
              hidden={activeTab !== "policy"}>
              <GlobalPolicySettings policy={runtimePolicy} disabled={policyDisabled} onUpdate={onUpdateGlobalPolicy} />
            </section>

            <section
              id="settings-panel-notifications"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-notifications"
              hidden={activeTab !== "notifications"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Notifications</h2>
                  <p>Preview the cues Pylon uses when work finishes or needs your attention.</p>
                </div>
              </div>
              <span className="settings-kicker">Sound cues</span>
              <div className="settings-option-list">
                <div>
                  <span>
                    <strong>Turn complete</strong>
                    <small>Played after the assistant finishes a turn.</small>
                  </span>
                  <button type="button" onClick={() => playSound("turn-complete")}>
                    Play preview
                  </button>
                </div>
                <div>
                  <span>
                    <strong>Attention required</strong>
                    <small>Played when Pylon needs approval or clarification.</small>
                  </span>
                  <button type="button" onClick={() => playSound("attention")}>
                    Play preview
                  </button>
                </div>
              </div>
            </section>

            <section
              id="settings-panel-models"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-models"
              hidden={activeTab !== "models"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Models</h2>
                  <p>
                    Choose which models appear in the model selector. The active session model always stays visible.
                  </p>
                </div>
                <input
                  type="search"
                  value={modelQuery}
                  onChange={event => setModelQuery(event.target.value)}
                  placeholder="Filter models"
                  aria-label="Filter models"
                />
              </div>
              {models.length === 0 && (
                <div className="settings-empty">
                  <strong>No models available</strong>
                  <span>Connect a provider first.</span>
                </div>
              )}
              {models.length > 0 && filteredModels.length === 0 && (
                <div className="settings-empty">
                  <strong>No matching models</strong>
                  <span>Try a different filter.</span>
                </div>
              )}
              {filteredModels.length > 0 && (
                <div className="settings-provider-groups">
                  {modelGroups.map(group => {
                    const allVisible = group.items.every(item => !hiddenModelKeys.has(`${item.provider}/${item.id}`));
                    return (
                      <section
                        className="settings-provider-group"
                        key={group.provider}
                        aria-labelledby={`model-group-${group.provider}`}>
                        <header>
                          <h3 id={`model-group-${group.provider}`}>{group.provider}</h3>
                          <label className="settings-model-all">
                            <input
                              type="checkbox"
                              checked={allVisible}
                              onChange={event => setProviderVisible(group.items, event.target.checked)}
                            />
                            Show all
                          </label>
                        </header>
                        <div className="settings-provider-list">
                          {group.items.map(item => {
                            const key = `${item.provider}/${item.id}`;
                            return (
                              <label className="settings-model-row" key={key}>
                                <span>
                                  <strong>{item.name}</strong>
                                  <small>{item.id}</small>
                                </span>
                                <input
                                  type="checkbox"
                                  checked={!hiddenModelKeys.has(key)}
                                  onChange={event => setHiddenModelVisible(key, event.target.checked)}
                                />
                              </label>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </section>

            <section
              id="settings-panel-appearance"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-appearance"
              hidden={activeTab !== "appearance"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Appearance</h2>
                  <p>Choose the color theme used throughout Pylon.</p>
                </div>
              </div>
              <span className="settings-kicker">Color theme</span>
              <div className="settings-theme-options">
                {(["dark", "light"] as const).map(option => (
                  <label key={option}>
                    <input
                      type="radio"
                      name="settings-theme"
                      value={option}
                      checked={theme === option}
                      onChange={() => onThemeChange(option)}
                    />
                    <span className={`theme-preview is-${option}`} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <strong>{option}</strong>
                  </label>
                ))}
              </div>
              <span className="settings-kicker settings-syntax-kicker">Syntax theme</span>
              <label className="settings-syntax-theme">
                <span>Code highlighting</span>
                <select
                  value={syntaxTheme}
                  onChange={event => onSyntaxThemeChange(event.target.value as SyntaxTheme)}>
                  {SYNTAX_THEMES.map(option => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small>Syntax themes and languages load in the background after startup.</small>
              </label>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function packageOrbState(state: string): OverviewState {
  if (state === "failed") return "failed";
  return state === "active" ? "done" : "neutral";
}

function toolOrbState(effective: string): OverviewState {
  if (effective === "active") return "done";
  return effective === "deferred" ? "attention" : "neutral";
}

function AndroidToolingSettings({
  status,
  busy,
  onAction,
}: {
  status?: HeliosAndroidToolingResult;
  busy: "" | "install" | "remove";
  onAction: (action: "status" | "install" | "remove") => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<"install" | "remove">();
  const [error, setError] = useState("");
  const working = Boolean(busy) || status?.state === "busy";
  const apply = async (action: "status" | "install" | "remove") => {
    setError("");
    try {
      await onAction(action);
      setConfirmation(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Android tooling operation failed");
    }
  };
  const setupLabel = status?.state === "ready" || status?.state === "invalid" ? "Repair" : "Install";
  const versionLabel = (value: string | undefined, fallback: string) =>
    status?.state === "ready" ? (value ?? fallback) : `target ${value ?? fallback}`;
  return (
    <section className="workbench-section android-tooling-settings" aria-labelledby="android-tooling-title">
      <header>
        <div>
          <h4 id="android-tooling-title">Android tooling</h4>
          <p>Managed Appium and UiAutomator2 for Helios. Android SDK, Java, and an AVD are still required.</p>
        </div>
        <span className={`android-tooling-state is-${status?.state ?? "unknown"}`}>{status?.state ?? "checking"}</span>
      </header>
      <div className="android-tooling-summary">
        <span>
          <strong>Appium</strong>
          <small>{versionLabel(status?.appiumVersion, "3.6.0")}</small>
        </span>
        <span>
          <strong>UiAutomator2</strong>
          <small>{versionLabel(status?.driverVersion, "8.2.2")}</small>
        </span>
      </div>
      {status?.message && <p className="android-tooling-message">{status.message}</p>}
      <div className="android-tooling-actions">
        <button type="button" disabled={working} onClick={() => void apply("status")}>
          Refresh
        </button>
        <button type="button" disabled={working} onClick={() => setConfirmation("install")}>
          {busy === "install" ? "Setting up…" : setupLabel}
        </button>
        {(status?.state === "ready" || status?.state === "invalid") && (
          <button className="is-danger" type="button" disabled={working} onClick={() => setConfirmation("remove")}>
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        )}
      </div>
      {confirmation && (
        <div
          className="android-tooling-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="android-tooling-confirm-title"
          aria-describedby="android-tooling-confirm-description">
          <strong id="android-tooling-confirm-title">
            {confirmation === "install" ? `${setupLabel} Android tooling?` : "Remove managed Android tooling?"}
          </strong>
          <p id="android-tooling-confirm-description">
            {confirmation === "install"
              ? "Pylon will download and execute repository-pinned npm packages in its local data directory. No global packages or emulator data are changed."
              : "Pylon will delete only its managed Appium installation. Active Android sessions must be closed first."}
          </p>
          <div>
            <button type="button" disabled={Boolean(busy)} onClick={() => setConfirmation(undefined)}>
              Cancel
            </button>
            <button
              autoFocus
              type="button"
              disabled={Boolean(busy)}
              className={confirmation === "remove" ? "is-danger" : ""}
              onClick={() => void apply(confirmation)}>
              Confirm
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="settings-policy-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const defaultGlobalPolicy: RuntimePolicyReadModel["global"] = {
  timelineEnabled: true,
  guardEnabled: true,
  guardRules: { ...DEFAULT_GUARD_RULES },
  workspace: "local",
  guardTimeoutSeconds: 60,
  clarifyTimeoutSeconds: 60,
};

function GlobalPolicySettings({
  policy,
  disabled,
  onUpdate,
}: {
  policy?: RuntimePolicyReadModel;
  disabled: boolean;
  onUpdate: (settings: RuntimePolicyReadModel["global"], expectedRevision: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RuntimePolicyReadModel["global"]>(policy?.global ?? defaultGlobalPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latestPolicy = useRef(policy);
  const saveRequest = useRef(0);

  useEffect(() => {
    latestPolicy.current = policy;
    if (!policy) return;
    saveRequest.current++;
    setDraft(policy.global);
    setBusy(false);
    setError("");
  }, [policy?.revision]);

  if (!policy)
    return (
      <div className="settings-empty">
        <strong>Global policy unavailable</strong>
        <span>Connect to a registered project to edit policy defaults.</span>
      </div>
    );

  const save = async (next: RuntimePolicyReadModel["global"]) => {
    const request = ++saveRequest.current;
    setDraft(next);
    setBusy(true);
    setError("");
    try {
      await onUpdate(next, policy.revision);
    } catch (cause) {
      if (request !== saveRequest.current) return;
      setDraft(latestPolicy.current?.global ?? policy.global);
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Global policy could not be saved");
    }
  };
  const controlsDisabled = disabled || busy;

  return (
    <>
      <div className="settings-pane-header">
        <div>
          <h2>Global policy defaults</h2>
          <p>
            Set the starting behavior for every project and session. Existing project and session overrides stay
            unchanged. Verify is configured per project in Inspector.
          </p>
        </div>
      </div>

      <div className="policy-inheritance" aria-label="Policy inheritance order">
        <span>
          <strong>Global</strong>
          <i aria-hidden="true">›</i>
          <b>Project</b>
          <i aria-hidden="true">›</i>
          <b>Session</b>
        </span>
        <small>The nearest override wins. Inherited values update when their source changes.</small>
      </div>

      <section className="settings-policy-group" aria-labelledby="global-policy-safety-title">
        <header>
          <h3 id="global-policy-safety-title">Activity and safety</h3>
          <p>Defaults for checkpoints, approvals, and response windows.</p>
        </header>
        <div className="settings-policy-list">
          <div className="settings-policy-row">
            <span>
              <strong>Timeline</strong>
              <small>Keep recoverable checkpoints for session activity.</small>
            </span>
            <label className="settings-policy-switch">
              <input
                type="checkbox"
                role="switch"
                checked={draft.timelineEnabled}
                disabled={controlsDisabled}
                onChange={event => void save({ ...draft, timelineEnabled: event.target.checked })}
              />
              <span aria-hidden="true" />
              <small>{draft.timelineEnabled ? "Enabled" : "Disabled"}</small>
            </label>
          </div>
          <div className="settings-policy-row">
            <span>
              <strong>Guard</strong>
              <small>Ask before guarded commands and paths run.</small>
            </span>
            <label className="settings-policy-switch">
              <input
                type="checkbox"
                role="switch"
                checked={draft.guardEnabled}
                disabled={controlsDisabled}
                onChange={event => void save({ ...draft, guardEnabled: event.target.checked })}
              />
              <span aria-hidden="true" />
              <small>{draft.guardEnabled ? "Enabled" : "Disabled"}</small>
            </label>
          </div>
          {GUARD_RISK_CATEGORIES.map(category => (
            <label className="settings-policy-row" key={category}>
              <span>
                <strong>{GUARD_RULE_LABELS[category]}</strong>
                <small>{GUARD_RULE_DESCRIPTIONS[category]}</small>
              </span>
              <select
                value={(draft.guardRules ?? DEFAULT_GUARD_RULES)[category]}
                disabled={controlsDisabled || !draft.guardEnabled}
                onChange={event =>
                  void save({
                    ...draft,
                    guardRules: {
                      ...(draft.guardRules ?? DEFAULT_GUARD_RULES),
                      [category]: event.target.value as (typeof GUARD_ACTIONS)[number],
                    },
                  })
                }>
                {GUARD_ACTIONS.map(action => (
                  <option value={action} key={action}>
                    {action === "allow" ? "Allow" : action === "confirm" ? "Confirm" : "Block"}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <RuntimePolicyTimeoutControl
            label="Guard timeout"
            description="How long a confirmation request stays open."
            value={draft.guardTimeoutSeconds}
            disabled={controlsDisabled}
            onChange={guardTimeoutSeconds => void save({ ...draft, guardTimeoutSeconds })}
          />
          <RuntimePolicyTimeoutControl
            label="Clarify timeout"
            description="How long Pylon waits for a clarification answer."
            value={draft.clarifyTimeoutSeconds}
            disabled={controlsDisabled}
            onChange={clarifyTimeoutSeconds => void save({ ...draft, clarifyTimeoutSeconds })}
          />
        </div>
      </section>

      <section className="settings-policy-group" aria-labelledby="global-policy-workspace-title">
        <header>
          <h3 id="global-policy-workspace-title">Workspace defaults</h3>
          <p>Choose where sessions begin work when no closer override exists.</p>
        </header>
        <div className="settings-policy-list">
          <label className="settings-policy-row">
            <span>
              <strong>Workspace</strong>
              <small>Local does not create a branch or worktree.</small>
            </span>
            <select
              value={draft.workspace}
              disabled={controlsDisabled}
              onChange={event =>
                void save({ ...draft, workspace: event.target.value as RuntimePolicyReadModel["global"]["workspace"] })
              }>
              <option value="local">Local</option>
              <option value="checkout">Project folder</option>
              <option value="worktree">Session worktree</option>
            </select>
          </label>
        </div>
      </section>

      <p className="settings-policy-note">
        <strong>Project and session overrides are not reset.</strong> Only inherited fields follow a new global default.
      </p>
      {disabled && <p className="settings-policy-note">Global policy can change when every active session is idle.</p>}
      {error && (
        <p className="settings-policy-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="settings-policy-saving" role="status">
          Saving…
        </p>
      )}
    </>
  );
}

/* One setting per row, with its explanation as the row's own description. The
   older two-column grid treated every child as a cell, so an explanatory note
   could land beside an unrelated field. */
function PackageRow({
  label,
  description,
  stacked = false,
  children,
}: {
  label: string;
  description?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`package-row${stacked ? " is-stacked" : ""}`}>
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {stacked ? children : <span className="package-row-control">{children}</span>}
    </div>
  );
}

function PackageSubgroup({ label, description }: { label: string; description: string }) {
  return (
    <div className="package-subgroup">
      <strong>{label}</strong>
      <small>{description}</small>
    </div>
  );
}

function PackageSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="package-switch">
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </label>
  );
}

function PackageNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <input
        key={value}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        disabled={disabled}
        aria-label={label}
        onBlur={event => {
          const next = Number(event.target.value);
          if (Number.isSafeInteger(next) && next >= min && next <= max) {
            if (next !== value) onChange(next);
            return;
          }
          event.currentTarget.value = String(value);
        }}
      />
      <span className="unit">{unit}</span>
    </>
  );
}

/* Multi-select sets were stacked checkbox fieldsets a full row tall each; chips
   carry the same choices without the row losing shape. At least one stays on. */
function PackageChips({
  label,
  description,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  options: { value: string; label: string }[];
  value: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <PackageRow label={label} description={description} stacked>
      <div className="package-chips">
        {options.map(option => (
          <label className="package-chip" key={option.value}>
            <input
              type="checkbox"
              checked={value.includes(option.value)}
              disabled={disabled || (value.length === 1 && value[0] === option.value)}
              onChange={event =>
                onChange(event.target.checked ? [...value, option.value] : value.filter(item => item !== option.value))
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </PackageRow>
  );
}

function hasPackageFields(settings: PackageSettingsReadModel | undefined): boolean {
  return Boolean(settings);
}

function PackageFields({
  settings,
  models,
  sessionThinkingLevels,
  disabled,
  onUpdate,
}: {
  settings: PackageSettingsReadModel;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  disabled: boolean;
  onUpdate: (settings: PackageSettingsReadModel) => void;
}) {
  if (settings.kind === "pylon-core") {
    return (
      <div className="package-list">
        <PackageRow
          label="Revision-guarded numbered edits"
          description="Uses revision-guarded numbered ranges when any advertised output price is at least 3× its input price. Lower-ratio models keep Pi's native read and edit for that session; missing pricing keeps numbered edits.">
          <PackageSwitch
            label="Toggle revision-guarded numbered edits"
            checked={settings.lineEditEnabled}
            disabled={disabled}
            onChange={lineEditEnabled => onUpdate({ ...settings, lineEditEnabled })}
          />
        </PackageRow>
      </div>
    );
  }
  if (settings.kind === "timeline") {
    return (
      <div className="package-list">
        <PackageRow
          label="Timeline titles"
          description="Generate short semantic checkpoint titles. An explicitly selected model also names new sessions; Disabled keeps original checkpoint prompt labels.">
          <ModelModeSelect
            label="Timeline title model"
            value={
              settings.checkpointTitleMode === "model" ? settings.checkpointTitleModel! : settings.checkpointTitleMode
            }
            models={models}
            disabled={disabled}
            onChange={value =>
              onUpdate({
                ...settings,
                checkpointTitleMode: value === "disabled" || value === "session" ? value : "model",
                checkpointTitleModel: value === "disabled" || value === "session" ? undefined : value,
              })
            }
          />
        </PackageRow>
        <p className="settings-callout">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>
            <strong>Checkpoint naming creates an extra model call for each changed turn.</strong>
            Use a cheap model to keep Timeline costs low.
          </span>
        </p>
        <PackageRow
          label="Rollback files when editing prompts"
          description="Restore the matching Timeline checkpoint by default when an earlier prompt is edited.">
          <PackageSwitch
            label="Toggle file rollback for edited prompts"
            checked={settings.editRollbackDefault}
            disabled={disabled}
            onChange={editRollbackDefault => onUpdate({ ...settings, editRollbackDefault })}
          />
        </PackageRow>
      </div>
    );
  }

  if (settings.kind === "advisor" || settings.kind === "scout") {
    const noun = settings.kind === "advisor" ? "the advisor" : "both scouts";
    const levels = thinkingLevels(
      settings.mode === "model" ? settings.model : undefined,
      models,
      sessionThinkingLevels,
    );
    return (
      <div className="package-list">
        <PackageRow label="Model" description={`Disabled turns ${noun} off for every session.`}>
          <ModelModeSelect
            label={`${settings.kind} model`}
            value={settings.mode === "model" ? settings.model! : settings.mode}
            models={models}
            disabled={disabled}
            onChange={value => onUpdate({ ...settings, ...modelModeUpdate(value) })}
          />
        </PackageRow>
        <PackageRow label="Thinking" description="Inherits the session level unless set here.">
          <ThinkingSelect
            label={`${settings.kind} thinking`}
            value={settings.thinking}
            levels={levels}
            disabled={disabled || settings.mode === "disabled"}
            onChange={thinking => onUpdate({ ...settings, thinking })}
          />
        </PackageRow>
        {settings.kind === "scout" && (
          <PackageRow
            label="OpenAI / Exa search for Web Scout"
            description="Optional. Search uses an existing OpenAI or Codex subscription when available, otherwise Exa; result pages still open through the isolated Helios browser.">
            <PackageSwitch
              label="Toggle web search"
              checked={settings.webSearch === true}
              disabled={disabled}
              onChange={webSearch => onUpdate({ ...settings, webSearch })}
            />
          </PackageRow>
        )}
      </div>
    );
  }
  if (settings.kind === "grunt") {
    return (
      <div className="package-list">
        <PackageRow label="Model" description="Disabled turns the grunt off for every session.">
          <ModelModeSelect
            label="Grunt model"
            value={settings.mode === "model" ? settings.model! : settings.mode}
            models={models}
            disabled={disabled}
            onChange={value => onUpdate({ ...settings, ...modelModeUpdate(value) })}
          />
        </PackageRow>
        <PackageRow label="Execution mode" description="Isolated runs in a scratch workspace; direct runs in place.">
          <select
            aria-label="Execution mode"
            value={settings.executionMode}
            disabled={disabled}
            onChange={event =>
              onUpdate({ ...settings, executionMode: event.target.value as typeof settings.executionMode })
            }>
            <option value="isolated">Isolated</option>
            <option value="direct">Direct</option>
            <option value="dynamic">Dynamic</option>
          </select>
        </PackageRow>
        <PackageRow
          label="Maximum tool-call turns"
          description="The grunt stops after this many tool calls in one run.">
          <PackageNumber
            label="Maximum tool-call turns"
            value={settings.maxTurns}
            min={1}
            max={1_000}
            unit="turns"
            disabled={disabled}
            onChange={maxTurns => onUpdate({ ...settings, maxTurns })}
          />
        </PackageRow>
        <PackageChips
          label="Eligible thinking levels"
          description="Levels a grunt run may use. At least one stays selected."
          options={thinkingChipOptions()}
          value={settings.thinkingLevels}
          disabled={disabled}
          onChange={levels => onUpdate({ ...settings, thinkingLevels: levels as ThinkingLevelReadModel[] })}
        />
      </div>
    );
  }
  if (settings.kind === "continuity") {
    return (
      <div className="package-list">
        <PackageRow label="Durable memory" description="Keep project notes and papercuts across sessions.">
          <PackageSwitch
            label="Toggle durable memory"
            checked={settings.memoryEnabled}
            disabled={disabled}
            onChange={memoryEnabled => onUpdate({ ...settings, memoryEnabled })}
          />
        </PackageRow>
        <PackageRow
          label="Automatic compaction reserve"
          description="Saved as the global default. Compaction begins when approximately this many context tokens remain; project .pi settings can override it.">
          <PackageNumber
            label="Automatic compaction reserve"
            value={settings.reserveTokens}
            min={1_000}
            max={1_000_000}
            step={1_000}
            unit="tokens"
            disabled={disabled}
            onChange={reserveTokens => onUpdate({ ...settings, reserveTokens })}
          />
        </PackageRow>
        <PackageRow
          label="Continuity retained tokens"
          description="Recent raw history kept by Continuity compaction. Overrides Pi's retained-token value only for Continuity-owned compactions.">
          <PackageNumber
            label="Continuity retained tokens"
            value={settings.keepRecentTokens}
            min={1_000}
            max={50_000}
            step={1_000}
            unit="tokens"
            disabled={disabled}
            onChange={keepRecentTokens => onUpdate({ ...settings, keepRecentTokens })}
          />
        </PackageRow>
        <PackageSubgroup
          label="Agent profiles"
          description="Each profile picks a model and a thinking level. Unset profiles fall back to the session model."
        />
        <ProfileRow
          label="Planner"
          description="Breaks a goal into the task list."
          profile={settings.planner}
          models={models}
          disabled={disabled}
          onChange={planner => onUpdate({ ...settings, planner })}
        />
        <ProfileRow
          label="Executor"
          description="Carries out each task in the list."
          profile={settings.executor}
          models={models}
          disabled={disabled}
          onChange={executor => onUpdate({ ...settings, executor })}
        />
        <ProfileRow
          label="Memory reviewer"
          description="Approves memories before they are stored."
          profile={settings.memoryReviewer}
          models={models}
          disabled={disabled}
          onChange={memoryReviewer => onUpdate({ ...settings, memoryReviewer })}
        />
        <ProfileRow
          label="Compaction reviewer"
          description="Checks the summary before history is dropped."
          profile={settings.compactionReviewer}
          models={models}
          disabled={disabled}
          onChange={compactionReviewer => onUpdate({ ...settings, compactionReviewer })}
        />
      </div>
    );
  }
  if (settings.kind === "sieve") {
    return (
      <div className="package-list">
        <PackageRow label="Active pruning" description="Remove stale tool results from context as the session runs.">
          <PackageSwitch
            label="Toggle active pruning"
            checked={settings.activePruning}
            disabled={disabled}
            onChange={activePruning => onUpdate({ ...settings, activePruning })}
          />
        </PackageRow>
        <PackageRow
          label="Projection mode"
          description="Stable is experimental and enables the rollover multipliers below.">
          <select
            aria-label="Projection mode"
            value={settings.projectionMode}
            disabled={disabled}
            onChange={event =>
              onUpdate({ ...settings, projectionMode: event.target.value as typeof settings.projectionMode })
            }>
            <option value="standard-v2">Standard (default)</option>
            <option value="legacy">Standard V1 (legacy)</option>
            <option value="stable">Stable (experimental)</option>
          </select>
        </PackageRow>
        <PackageRow label="Pruning threshold" description="Results larger than this are eligible for pruning.">
          <PackageNumber
            label="Pruning threshold"
            value={settings.threshold}
            min={1_000}
            max={50_000}
            step={1_000}
            unit="characters"
            disabled={disabled}
            onChange={threshold => onUpdate({ ...settings, threshold })}
          />
        </PackageRow>
        {settings.projectionMode === "stable" && (
          <>
            <PackageSubgroup
              label="Rollover"
              description="Stable projection only. The high multiplier must stay above the target."
            />
            <PackageRow
              label="High multiplier"
              description="Rollover begins once retained content passes this multiple of the threshold.">
              <PackageNumber
                label="Rollover high multiplier"
                value={settings.rolloverHighMultiplier}
                min={settings.rolloverLowMultiplier + 1}
                max={64}
                unit="×"
                disabled={disabled}
                onChange={rolloverHighMultiplier => onUpdate({ ...settings, rolloverHighMultiplier })}
              />
            </PackageRow>
            <PackageRow
              label="Target multiplier"
              description="Rollover stops once retained content falls to this multiple.">
              <PackageNumber
                label="Rollover target multiplier"
                value={settings.rolloverLowMultiplier}
                min={1}
                max={settings.rolloverHighMultiplier - 1}
                unit="×"
                disabled={disabled}
                onChange={rolloverLowMultiplier => onUpdate({ ...settings, rolloverLowMultiplier })}
              />
            </PackageRow>
          </>
        )}
      </div>
    );
  }
  if (settings.kind === "spawn") {
    const available = models.map(model => ({ value: modelKey(model), label: model.name }));
    const eligible = settings.models;
    const options = [
      ...available,
      ...(eligible ?? [])
        .filter(ref => !available.some(model => model.value === ref))
        .map(ref => ({ value: ref, label: ref })),
    ];
    return (
      <div className="package-list">
        <PackageRow label="All available models" description="Let private agents use every model the session can see.">
          <PackageSwitch
            label="Toggle all available models"
            checked={eligible === undefined}
            disabled={disabled || !available.length}
            onChange={all => onUpdate({ ...settings, models: all ? undefined : available.map(model => model.value) })}
          />
        </PackageRow>
        <PackageChips
          label="Eligible models"
          description="Models a private agent may be spawned with. At least one stays selected."
          options={options}
          value={eligible ?? []}
          disabled={disabled || eligible === undefined}
          onChange={next => onUpdate({ ...settings, models: next })}
        />
        <PackageChips
          label="Private-agent thinking"
          description="Thinking levels a private agent may be spawned with."
          options={thinkingChipOptions()}
          value={settings.agentThinkingLevels}
          disabled={disabled}
          onChange={levels => onUpdate({ ...settings, agentThinkingLevels: levels as ThinkingLevelReadModel[] })}
        />
      </div>
    );
  }
  if (settings.kind !== "helios") return null;
  return (
    <div className="package-list">
      <PackageRow label="Future owned browsers" description="Whether browsers Helios launches from now on are visible.">
        <select
          aria-label="Future owned browsers"
          value={settings.headed ? "shown" : "headless"}
          disabled={disabled}
          onChange={event => onUpdate({ ...settings, headed: event.target.value === "shown" })}>
          <option value="shown">Shown</option>
          <option value="headless">Headless</option>
        </select>
      </PackageRow>
    </div>
  );
}

function thinkingChipOptions(): { value: string; label: string }[] {
  return PACKAGE_THINKING_LEVELS.map(level => ({ value: level, label: thinkingLabel(level) }));
}

/* "disabled" and "session" are modes; anything else is a model reference. */
function modelModeUpdate(value: string): { mode: "disabled" | "session" | "model"; model?: string } {
  if (value === "disabled" || value === "session") return { mode: value, model: undefined };
  return { mode: "model", model: value };
}

function ModelModeSelect({
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const hiddenModels = useHiddenModels();
  const options = visibleModels(models, hiddenModels);
  const selected = models.find(model => modelKey(model) === value);
  if (selected && !options.some(model => modelKey(model) === value)) options.push(selected);
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="disabled">Disabled</option>
      <option value="session">Use session model</option>
      {options.map(model => (
        <option value={modelKey(model)} key={modelKey(model)}>
          {model.name}
        </option>
      ))}
    </select>
  );
}

/* A profile is a model plus a thinking level: two controls, one row. */
function ProfileRow({
  label,
  description,
  profile,
  models,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  profile?: { model: string; thinking?: ThinkingLevelReadModel };
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (profile: { model: string; thinking?: ThinkingLevelReadModel } | undefined) => void;
}) {
  const levels = thinkingLevels(profile?.model, models, []);
  return (
    <div className="package-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="package-row-control is-pair">
        <select
          aria-label={`${label} model`}
          value={profile?.model ?? ""}
          disabled={disabled}
          onChange={event => onChange(event.target.value ? { model: event.target.value } : undefined)}>
          <option value="">Not configured</option>
          {models.map(model => (
            <option value={modelKey(model)} key={modelKey(model)}>
              {model.name}
            </option>
          ))}
        </select>
        <ThinkingSelect
          label={`${label} thinking`}
          value={profile?.thinking}
          levels={levels}
          disabled={disabled || !profile}
          onChange={thinking => profile && onChange({ ...profile, thinking })}
        />
      </span>
    </div>
  );
}

function ThinkingSelect({
  label,
  value,
  levels,
  disabled,
  onChange,
}: {
  label: string;
  value?: ThinkingLevelReadModel;
  levels: ThinkingLevelReadModel[];
  disabled: boolean;
  onChange: (value?: ThinkingLevelReadModel) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      onChange={event => onChange(event.target.value ? (event.target.value as ThinkingLevelReadModel) : undefined)}>
      <option value="">Inherit session thinking</option>
      {levels.map(level => (
        <option value={level} key={level}>
          {thinkingLabel(level)}
        </option>
      ))}
    </select>
  );
}

function thinkingLevels(
  modelRef: string | undefined,
  models: ModelOptionReadModel[],
  fallback: ThinkingLevelReadModel[],
): ThinkingLevelReadModel[] {
  return modelRef
    ? (models.find(model => `${model.provider}/${model.id}` === modelRef)?.thinkingLevels ?? [])
    : fallback;
}
