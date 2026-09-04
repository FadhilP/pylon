import {
  IconBell,
  IconChevronDown,
  IconChevronUp,
  IconAlertTriangle,
  IconContrast,
  IconExternalLink,
  IconKey,
  IconLogout,
  IconPackages,
  IconPlugConnected,
  IconPuzzle,
  IconSettings,
  IconSearch,
  IconShield,
  IconBook,
  IconStack2,
  IconWebhook,
  IconX,
} from "@tabler/icons-react";
import {
  createContext,
  useEffect,
  useContext,
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
import { defaultGlobalPolicy } from "../shared/policy-defaults";
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
  SkillListSnapshot,
  ToolExposureMode,
} from "../shared/protocol/snapshots";
import { DEFAULT_SYNTAX_THEME, SYNTAX_THEMES, type SyntaxTheme } from "../shared/syntax-highlighting";
import { thinkingLabel } from "./format";
import { ExtensionSettingsFields } from "./extension-settings-fields";
import { HookSettingsFields } from "./hook-settings-fields";
import { RuntimePolicyTimeoutControl } from "./runtime-policy-timeout";
import {
  buildSettingsSearchIndex,
  searchSettings,
  settingSearchTarget,
  type SettingsSearchEntry,
} from "../shared/settings-search";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";
import { UiDialog } from "./ui-dialog";
import { modelKey, selectableModels, setHiddenModelVisible, useHiddenModels, visibleModels } from "./model-visibility";
import { OverviewOrb, type OverviewState } from "./overview-primitives";
import { DEFAULT_THEME, type Theme } from "./use-chrome";

export type SettingsTab =
  | "providers"
  | "models"
  | "agent-models"
  | "packages"
  | "extensions"
  | "skills"
  | "hooks"
  | "policy"
  | "notifications"
  | "appearance";
/* Grouping the ten sections names the thing each one governs; the flat order
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
      { tab: "agent-models", label: "Agent models", icon: <IconSettings size={15} /> },
      { tab: "packages", label: "Packages", icon: <IconPackages size={15} /> },
      { tab: "extensions", label: "Extensions", icon: <IconPuzzle size={15} /> },
      { tab: "skills", label: "Skills", icon: <IconBook size={15} /> },
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
const PackageSearchTargetContext = createContext<string | undefined>(undefined);
interface SettingsDialogProps {
  initialTab?: SettingsTab;
  initialProviderQuery?: string;
  initialPackageQuery?: string;
  providerAuth?: ProviderAuthReadModel;
  pendingUi?: UiRequestReadModel;
  packages: PackageSummary[];
  projects: { id: string; label: string }[];
  extensions?: ExtensionListSnapshot;
  skills?: SkillListSnapshot;
  hookSettings?: HookSettingsReadModel;
  runtimePolicy?: RuntimePolicyReadModel;
  toolPolicies: ToolPolicyReadModel[];
  policyDisabled: boolean;
  loading: boolean;
  extensionLoading: boolean;
  skillLoading: boolean;
  hookLoading: boolean;
  busy: string;
  extensionBusy: boolean;
  hookBusy: boolean;
  androidTooling?: HeliosAndroidToolingResult;
  androidToolingBusy: "" | "install" | "remove";
  providerLogoutDisabled: boolean;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
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
  skills,
  hookSettings,
  runtimePolicy,
  toolPolicies,
  policyDisabled,
  loading,
  extensionLoading,
  skillLoading,
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
  const [providerFilter, setProviderFilter] = useState<"all" | "connected" | "available">("all");
  const [packageQuery, setPackageQuery] = useState(initialPackageQuery);
  const [modelQuery, setModelQuery] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [toolPolicyBusy, setToolPolicyBusy] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingSearchTarget, setPendingSearchTarget] = useState<SettingsSearchEntry>();
  const [hookSearchSelection, setHookSearchSelection] = useState<{
    hookKey: keyof HookSettingsReadModel;
    sourceId?: string;
  }>();
  const filteredPackages = packages.filter(item =>
    `${item.name} ${item.description}`.toLowerCase().includes(packageQuery.trim().toLowerCase()),
  );
  const providers = providerAuth?.providers ?? [];
  const filteredProviders = providers
    .filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const connectedProviders = filteredProviders.filter(provider => provider.configured);
  const availableProviders = filteredProviders.filter(provider => !provider.configured);
  const providerGroups = [
    { id: "connected", label: "Connected", providers: providerFilter === "available" ? [] : connectedProviders },
    { id: "available", label: "Available", providers: providerFilter === "connected" ? [] : availableProviders },
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
  const searchResults = searchSettings(
    buildSettingsSearchIndex({ providers, models, packages, extensions, skills, hookSettings, toolPolicies }),
    searchQuery,
  );
  const agentModelPackages = packages.filter(item => hasAgentModelFields(item.settings));
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
  /* The flow renders under the provider row that started it, so you keep
     your place in the list and it is obvious which account is connecting.
     A prompt that names no provider still falls back to the top. */
  const authTask = (authFlow || providerPrompt) && (
    <section className={`provider-auth-task is-${authFlow?.status ?? "running"}`} aria-labelledby="provider-auth-title">
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
          <a className="provider-auth-primary" href={primaryAuthLink.url} target="_blank" rel="noopener noreferrer">
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
  );

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!pendingSearchTarget) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = dialogRef.current?.querySelector<HTMLElement>(`#settings-panel-${pendingSearchTarget.tab}`);
      if (!panel) return;
      const packageScope = pendingSearchTarget.packageId
        ? [...panel.querySelectorAll<HTMLElement>("[data-settings-search-package]")].find(
            element => element.dataset.settingsSearchPackage === pendingSearchTarget.packageId,
          )
        : undefined;
      const scope = packageScope ?? panel;
      const target =
        [...scope.querySelectorAll<HTMLElement>("[data-settings-search-target]")].find(
          element => element.dataset.settingsSearchTarget === pendingSearchTarget.target,
        ) ?? scope;
      target.scrollIntoView({ block: "center" });
      const control = target.matches("button, input, select, textarea")
        ? target
        : target.querySelector<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          );
      if (control) control.focus({ preventScroll: true });
      else {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
      setPendingSearchTarget(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, hookSearchSelection, pendingSearchTarget, selectedPackageId]);

  const playSound = (kind: "turn-complete" | "attention") => {
    unlockWebAudio();
    enqueueWebAudioCues([kind]);
  };

  const openSearchResult = (result: SettingsSearchEntry) => {
    setPendingSearchTarget(result);
    setSearchQuery("");
    setActiveTab(result.tab);
    if (result.tab === "providers") setProviderQuery("");
    if (result.tab === "models") setModelQuery("");
    if (result.packageId) {
      setPackageQuery("");
      setSelectedPackageId(result.packageId);
    }
    if (result.hookKey) setHookSearchSelection({ hookKey: result.hookKey, sourceId: result.hookSourceId });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (searchQuery.trim()) {
        event.preventDefault();
        setSearchQuery("");
        return;
      }
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
    setSearchQuery("");
    setActiveTab(SETTINGS_TABS[next]!);
    dialogRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };

  const hookKeys = ["sessionStart", "beforeAgentStart"] as const;
  const navCounts: Partial<Record<SettingsTab, string>> = {
    providers: providers.length
      ? `${providers.filter(provider => provider.configured).length}/${providers.length}`
      : "",
    models: models.length ? String(models.length) : "",
    "agent-models": agentModelPackages.length ? String(agentModelPackages.length) : "",
    packages: packages.length ? String(packages.length) : "",
    extensions: extensions ? String(extensions.extensions.length) : "",
    skills: skills ? String(skills.skills.length) : "",
    hooks: hookSettings ? `${hookKeys.filter(key => hookSettings[key].enabled).length}/${hookKeys.length}` : "",
  };
  const isWorkbenchTab = activeTab === "packages" || activeTab === "hooks";

  const selectedPackage = filteredPackages.find(item => item.id === selectedPackageId) ?? filteredPackages[0];
  const selectedToolPolicy = selectedPackage
    ? toolPolicies.find(policy => policy.owner === selectedPackage.id)
    : undefined;
  const selectedTools = selectedToolPolicy?.managedTools ?? [];

  const renderSearchControl = (result: SettingsSearchEntry): ReactNode => {
    const control = result.control;
    if (!control) return null;
    if (control.kind === "sound") {
      return (
        <button type="button" onClick={() => playSound(control.cue)}>
          Play preview
        </button>
      );
    }
    if (control.kind === "theme") {
      return <ColorThemeOptions theme={theme} onChange={onThemeChange} />;
    }
    if (control.kind === "syntax-theme") {
      return <SyntaxThemeSelect value={syntaxTheme} onChange={onSyntaxThemeChange} />;
    }
    if (control.kind === "model") {
      const model = models.find(item => modelKey(item) === control.modelKey);
      return model ? <ModelVisibilityControl model={model} hidden={hiddenModelKeys.has(control.modelKey)} /> : null;
    }
    const item = packages.find(candidate => candidate.id === control.packageId);
    if (!item) return null;
    if (control.kind === "package") {
      return (
        <PackageRow label="Package enabled" description="Enable or disable this package globally.">
          <PackageSwitch
            label={`Toggle ${item.name}`}
            checked={item.enabled}
            disabled={Boolean(busy)}
            onChange={enabled => onSetEnabled(item, enabled)}
          />
        </PackageRow>
      );
    }
    if (control.kind === "package-field") {
      return item.settings ? (
        <PackageFields
          settings={item.settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={Boolean(busy)}
          searchTarget={result.target}
          onUpdate={settings => onUpdate(item, settings)}
        />
      ) : null;
    }
    const policy = toolPolicies.find(candidate => candidate.owner === control.packageId);
    return (
      <ToolExposureRow
        tool={control.tool}
        policy={policy}
        runtimePolicy={runtimePolicy}
        policyDisabled={policyDisabled}
        busy={toolPolicyBusy === control.tool}
        onBusyChange={working => setToolPolicyBusy(working ? control.tool : "")}
        onUpdate={onUpdateGlobalToolPolicy}
      />
    );
  };

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
          <label className="settings-global-search">
            <IconSearch size={15} aria-hidden="true" />
            <input
              data-autofocus
              type="search"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              aria-controls="settings-search-results"
            />
          </label>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">
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
                      onClick={() => {
                        setSearchQuery("");
                        setActiveTab(entry.tab);
                      }}
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

          <div className={`settings-content${isWorkbenchTab && !searchQuery.trim() ? " is-workbench" : ""}`}>
            {searchQuery.trim() && (
              <section
                id="settings-search-results"
                className="settings-pane settings-search-results"
                aria-label="Settings search results">
                <div className="settings-pane-header">
                  <div>
                    <h2>Search results</h2>
                    <p aria-live="polite">
                      {searchResults.length} result{searchResults.length === 1 ? "" : "s"} for “{searchQuery.trim()}”
                    </p>
                  </div>
                </div>
                {searchResults.length ? (
                  <div className="settings-search-result-list">
                    {searchResults.map(result => (
                      <article className={result.control ? "is-editable" : undefined} key={result.id}>
                        <header>
                          <span>
                            <strong>{result.label}</strong>
                            {result.description && <small>{result.description}</small>}
                          </span>
                          <span>
                            <b>{result.section}</b>
                            <button type="button" onClick={() => openSearchResult(result)}>
                              Open setting
                            </button>
                          </span>
                        </header>
                        {result.control && (
                          <div className="settings-search-inline-control">{renderSearchControl(result)}</div>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="settings-empty">
                    <strong>No matching settings</strong>
                    <span>Try a setting name, description, package, model, or provider.</span>
                  </div>
                )}
              </section>
            )}
            <section
              id="settings-panel-providers"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-providers"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "providers"}>
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
              {/* Three words rather than a segmented control, and the counts
                  answer "how many of each" before you pick one. */}
              <div className="settings-filter" role="group" aria-label="Filter providers by connection">
                {(
                  [
                    ["all", "All", filteredProviders.length, undefined],
                    ["connected", "Connected", connectedProviders.length, "done"],
                    ["available", "Not connected", availableProviders.length, "neutral"],
                  ] as const
                ).map(([value, label, count, orb]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={providerFilter === value}
                    onClick={() => setProviderFilter(value)}>
                    {orb && <OverviewOrb state={orb} label={label} />}
                    {label} <b>{count}</b>
                  </button>
                ))}
              </div>
              {!authFlow && providerPrompt && authTask}
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
                              <section
                                className={`settings-provider${authFlow?.providerId === provider.id ? " is-open" : ""}`}
                                data-settings-search-target={`provider-${settingSearchTarget(provider.id)}`}
                                key={provider.id}>
                                {/* Green once connected, amber while a sign-in
                                    is in flight, grey when there is nothing
                                    set up. The provider is not a preference,
                                    so the orb reports state, not provenance. */}
                                <OverviewOrb
                                  state={
                                    authFlow?.providerId === provider.id && authRunning
                                      ? "attention"
                                      : provider.configured
                                        ? "done"
                                        : "neutral"
                                  }
                                  label={provider.configured ? "connected" : "not connected"}
                                />
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
                                {authFlow?.providerId === provider.id && authTask}
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
              hidden={Boolean(searchQuery.trim()) || activeTab !== "packages"}>
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
                  <article className="package-workbench-detail" data-settings-search-package={selectedPackage.id}>
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
                    <section className="workbench-section" data-settings-search-target="package-defaults">
                      <header>
                        <div>
                          <h4>Package defaults</h4>
                          <p>Configuration owned by this package.</p>
                        </div>
                        <PackageDefaultsReset
                          settings={selectedPackage.settings}
                          disabled={Boolean(busy)}
                          onUpdate={settings => onUpdate(selectedPackage, settings)}
                        />
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
                          {selectedTools.map(tool => (
                            <ToolExposureRow
                              key={tool}
                              tool={tool}
                              policy={selectedToolPolicy}
                              runtimePolicy={runtimePolicy}
                              policyDisabled={policyDisabled}
                              busy={toolPolicyBusy === tool}
                              onBusyChange={working => setToolPolicyBusy(working ? tool : "")}
                              onUpdate={onUpdateGlobalToolPolicy}
                            />
                          ))}
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
              hidden={Boolean(searchQuery.trim()) || activeTab !== "extensions"}>
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
              id="settings-panel-skills"
              className="settings-pane skills-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-skills"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "skills"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Skills</h2>
                  <p>
                    Inspect the skills loaded for the selected Pi session from global, project, and package sources.
                  </p>
                </div>
              </div>
              {skillLoading && (
                <div className="settings-empty">
                  <strong>Loading skills…</strong>
                </div>
              )}
              {!skillLoading && !skills && (
                <div className="settings-empty">
                  <strong>Skills unavailable</strong>
                  <span>The selected session did not provide a skill inventory.</span>
                </div>
              )}
              {!skillLoading && skills?.projectTrustRequired && !skills.projectTrusted && (
                <div className="settings-callout">
                  <IconShield size={16} aria-hidden="true" />
                  <span>
                    <strong>Project resources are not trusted</strong>
                    Project skills remain unloaded until this project is trusted. Project trust can be managed in
                    Extensions.
                  </span>
                </div>
              )}
              {!skillLoading && skills && skills.diagnostics.length > 0 && (
                <div className="skill-diagnostics" aria-label="Skill diagnostics">
                  {skills.diagnostics.map((diagnostic, index) => (
                    <div className="settings-callout" key={`${diagnostic.type}-${diagnostic.path ?? index}`}>
                      <IconAlertTriangle size={16} aria-hidden="true" />
                      <span>
                        <strong>
                          {diagnostic.type === "collision" ? "Skill name collision" : `Skill ${diagnostic.type}`}
                        </strong>
                        {diagnostic.message}
                        {diagnostic.path ? ` · ${diagnostic.path}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {!skillLoading && skills && skills.skills.length === 0 && (
                <div className="settings-empty">
                  <strong>No skills loaded</strong>
                  <span>Add skills under the stock Pi skill locations, then reload or start a new session.</span>
                </div>
              )}
              {!skillLoading && skills && skills.skills.length > 0 && (
                <div className="settings-provider-groups">
                  {(["user", "project", "temporary"] as const).map(scope => {
                    const items = skills.skills.filter(skill => skill.scope === scope);
                    if (!items.length) return null;
                    const label = scope === "user" ? "Global" : scope === "project" ? "Project" : "Temporary";
                    return (
                      <section className="settings-provider-group" key={scope} aria-labelledby={`skill-group-${scope}`}>
                        <header>
                          <h3 id={`skill-group-${scope}`}>{label}</h3>
                          <span>{items.length}</span>
                        </header>
                        <div className="settings-option-list">
                          {items.map(skill => (
                            <div key={skill.id} data-settings-search-target={`skill-${settingSearchTarget(skill.id)}`}>
                              <span>
                                <strong>{skill.name}</strong>
                                <small>{skill.description}</small>
                                <small className="skill-meta">
                                  {skill.path} · {skill.source}
                                </small>
                              </span>
                              <span className="provider-state">{skill.manualOnly ? "Manual only" : "Automatic"}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </section>

            <section
              id="settings-panel-hooks"
              className="settings-pane hooks-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-hooks"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "hooks"}>
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
                searchSelection={hookSearchSelection}
                onUpdate={onUpdateHooks}
              />
            </section>

            <section
              id="settings-panel-policy"
              className="settings-pane global-policy-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-policy"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "policy"}>
              <GlobalPolicySettings policy={runtimePolicy} disabled={policyDisabled} onUpdate={onUpdateGlobalPolicy} />
            </section>

            <section
              id="settings-panel-notifications"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-notifications"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "notifications"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Notifications</h2>
                  <p>Preview the cues Pylon uses when work finishes or needs your attention.</p>
                </div>
              </div>
              <span className="settings-kicker">Sound cues</span>
              <div className="settings-option-list">
                <div data-settings-search-target="turn-complete">
                  <span>
                    <strong>Turn complete</strong>
                    <small>Played after the assistant finishes a turn.</small>
                  </span>
                  <button type="button" onClick={() => playSound("turn-complete")}>
                    Play preview
                  </button>
                </div>
                <div data-settings-search-target="attention-required">
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
              hidden={Boolean(searchQuery.trim()) || activeTab !== "models"}>
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
                          {/* The same switch the rows use, so a group and the
                              models inside it read as one control. */}
                          <label className="settings-model-all package-switch">
                            <span>Show all</span>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={allVisible}
                              aria-label={`Show all ${group.provider} models`}
                              onChange={event => setProviderVisible(group.items, event.target.checked)}
                            />
                          </label>
                        </header>
                        <div className="settings-provider-list">
                          {group.items.map(item => (
                            <ModelVisibilityControl
                              key={modelKey(item)}
                              model={item}
                              hidden={hiddenModelKeys.has(modelKey(item))}
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </section>

            <section
              id="settings-panel-agent-models"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-agent-models"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "agent-models"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Agent models</h2>
                  <p>Choose the models and thinking levels used by Pylon agents and background tasks.</p>
                </div>
              </div>
              <AgentModelSettings
                packages={agentModelPackages}
                models={models}
                sessionThinkingLevels={sessionThinkingLevels}
                loading={loading}
                disabled={Boolean(busy)}
                onUpdate={onUpdate}
              />
            </section>

            <section
              id="settings-panel-appearance"
              className="settings-pane"
              role="tabpanel"
              aria-labelledby="settings-tab-appearance"
              hidden={Boolean(searchQuery.trim()) || activeTab !== "appearance"}>
              <div className="settings-pane-header">
                <div>
                  <h2>Appearance</h2>
                  <p>Choose the color theme used throughout Pylon.</p>
                </div>
              </div>
              <SettingsSectionHead
                label="Color theme"
                changed={theme !== DEFAULT_THEME}
                onReset={() => onThemeChange(DEFAULT_THEME)}
              />
              <ColorThemeOptions theme={theme} onChange={onThemeChange} />
              <SettingsSectionHead
                label="Syntax theme"
                className="settings-syntax-kicker"
                changed={syntaxTheme !== DEFAULT_SYNTAX_THEME}
                onReset={() => onSyntaxThemeChange(DEFAULT_SYNTAX_THEME)}
              />
              <SyntaxThemeSelect value={syntaxTheme} onChange={onSyntaxThemeChange} />
            </section>
          </div>
        </div>
        <SettingsLegend tab={activeTab} />
      </div>
    </div>
  );
}

/* The orbs need naming once, but only on panes that have a rail to read.
   Providers names its own states in words, and Models says shown or hidden
   next to every switch, so neither one needs a key. */
const SPLIT_LEGEND_TABS: SettingsTab[] = ["packages", "extensions"];
const SIMPLE_LEGEND_TABS: SettingsTab[] = ["policy", "agent-models", "notifications", "appearance", "hooks"];

function SettingsLegend({ tab }: { tab: SettingsTab }) {
  const split = SPLIT_LEGEND_TABS.includes(tab);
  if (!split && !SIMPLE_LEGEND_TABS.includes(tab)) return null;
  return (
    <footer className="settings-legend" aria-hidden="true">
      <span>
        <i className="overview-orb is-neutral" /> default
      </span>
      <span>
        <i className="overview-orb is-changed" /> set
      </span>
      {split && (
        <>
          <span>
            <i className="overview-orb is-neutral run-active" /> default, live
          </span>
          <span>
            <i className="overview-orb is-changed run-deferred" /> set, deferred
          </span>
        </>
      )}
    </footer>
  );
}

/* A section whose control is not a row still reports whether you moved it
   off the default, so the whole dialog answers the same question. */
function SettingsSectionHead({
  label,
  className,
  changed,
  onReset,
}: {
  label: string;
  className?: string;
  changed: boolean;
  onReset: () => void;
}) {
  return (
    <span className={`settings-kicker${className ? ` ${className}` : ""}`}>
      <OverviewOrb state={changed ? "changed" : "neutral"} label={changed ? "changed" : "default"} />
      {label}
      {changed && (
        <button className="package-row-reset" type="button" onClick={onReset}>
          Reset
        </button>
      )}
    </span>
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

/* The orb reports whether the model is actually in the switcher: green when
   it is, grey when you have hidden it. Hiding is also the only way this row
   can differ from its default, so the reset hangs off the same condition. */
function ModelVisibilityControl({ model, hidden }: { model: ModelOptionReadModel; hidden: boolean }) {
  const key = modelKey(model);
  return (
    <label
      className="settings-model-row"
      data-settings-search-target={`model-${settingSearchTarget(`${model.provider}-${model.id}`)}`}>
      <OverviewOrb state={hidden ? "neutral" : "done"} label={hidden ? "hidden" : "shown"} />
      <span>
        <strong>{model.name}</strong>
        <small>{model.id}</small>
      </span>
      {/* No reset here: the switch is the reset. Every model is shown by
          default, so flipping it back is the whole revert. */}
      <span className="settings-row-control">
        <span className="package-switch">
          <input
            type="checkbox"
            role="switch"
            checked={!hidden}
            aria-label={`Show ${model.name}`}
            onChange={event => setHiddenModelVisible(key, event.target.checked)}
          />
          <small>{hidden ? "Hidden" : "Shown"}</small>
        </span>
      </span>
    </label>
  );
}

function ColorThemeOptions({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="settings-theme-options" data-settings-search-target="color-theme">
      {(["dark", "light", "warm"] as const).map(option => (
        <label key={option}>
          <input
            type="radio"
            name="settings-theme"
            value={option}
            checked={theme === option}
            onChange={() => onChange(option)}
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
  );
}

function SyntaxThemeSelect({ value, onChange }: { value: SyntaxTheme; onChange: (theme: SyntaxTheme) => void }) {
  return (
    <label className="settings-syntax-theme" data-settings-search-target="code-highlighting">
      <span>Code highlighting</span>
      <select value={value} onChange={event => onChange(event.target.value as SyntaxTheme)}>
        {SYNTAX_THEMES.map(option => (
          <option value={option.id} key={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <small>Syntax themes and languages load in the background after startup.</small>
    </label>
  );
}

function ToolExposureRow({
  tool,
  policy,
  runtimePolicy,
  policyDisabled,
  busy,
  onBusyChange,
  onUpdate,
}: {
  tool: string;
  policy?: ToolPolicyReadModel;
  runtimePolicy?: RuntimePolicyReadModel;
  policyDisabled: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onUpdate: (tool: string, mode: ToolExposureMode | "inherit", expectedRevision: number) => Promise<void>;
}) {
  const capable = policy?.enabledTools.includes(tool) === true;
  const packageDefault = policy?.deferredTools.includes(tool) ? "deferred" : capable ? "active" : "disabled";
  const override = runtimePolicy?.global.toolOverrides?.[tool];
  const effective = capable ? (override ?? packageDefault) : "disabled";
  const locked = tool === "search_tools";
  const rowClasses = ["workbench-tool-row", override && "is-override", locked && "is-locked"];
  return (
    <label
      className={rowClasses.filter(Boolean).join(" ")}
      data-effective={effective}
      data-settings-search-target={`tool-${settingSearchTarget(tool)}`}>
      <OverviewOrb state={toolOrbState(effective)} label={`Current setting: ${effective}`} />
      <span>
        <strong>{tool}</strong>
        <small>{locked ? "always on" : effective}</small>
      </span>
      <select
        value={override ?? "inherit"}
        disabled={locked || !runtimePolicy || policyDisabled || busy || (!capable && !override)}
        onChange={event => {
          if (!runtimePolicy) return;
          const mode = event.target.value as ToolExposureMode | "inherit";
          onBusyChange(true);
          void onUpdate(tool, mode, runtimePolicy.revision).finally(() => onBusyChange(false));
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
    <section
      className="workbench-section android-tooling-settings"
      data-settings-search-target="android-tooling"
      aria-labelledby="android-tooling-title">
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

/* Policy rows all report the same thing, so they share one orb. */
function PolicyOrb({ changed }: { changed: boolean }) {
  return <OverviewOrb state={changed ? "changed" : "neutral"} label={changed ? "changed" : "default"} />;
}

function GlobalPolicySettings({
  policy,
  disabled,
  onUpdate,
}: {
  policy?: RuntimePolicyReadModel;
  disabled: boolean;
  onUpdate: (settings: RuntimePolicyReadModel["global"], expectedRevision: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RuntimePolicyReadModel["global"]>(policy?.global ?? defaultGlobalPolicy());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const policyDefaults = defaultGlobalPolicy();
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
  const draftGuardRules = draft.guardRules ?? DEFAULT_GUARD_RULES;
  const changedPolicyCount =
    (draft.timelineEnabled !== policyDefaults.timelineEnabled ? 1 : 0) +
    (draft.guardEnabled !== policyDefaults.guardEnabled ? 1 : 0) +
    (draft.workspace !== policyDefaults.workspace ? 1 : 0) +
    (draft.guardTimeoutSeconds !== policyDefaults.guardTimeoutSeconds ? 1 : 0) +
    (draft.clarifyTimeoutSeconds !== policyDefaults.clarifyTimeoutSeconds ? 1 : 0) +
    GUARD_RISK_CATEGORIES.filter(c => draftGuardRules[c] !== policyDefaults.guardRules[c]).length;

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
        {changedPolicyCount > 0 && (
          <button
            type="button"
            className="workbench-reset"
            disabled={controlsDisabled}
            onClick={() => void save({ ...draft, ...defaultGlobalPolicy(), toolOverrides: draft.toolOverrides })}>
            Reset {changedPolicyCount} setting{changedPolicyCount === 1 ? "" : "s"}
          </button>
        )}
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
          <div className="settings-policy-row" data-settings-search-target="timeline">
            <PolicyOrb changed={draft.timelineEnabled !== policyDefaults.timelineEnabled} />
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
          <div className="settings-policy-row" data-settings-search-target="guard">
            <PolicyOrb changed={draft.guardEnabled !== policyDefaults.guardEnabled} />
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
            <label
              className="settings-policy-row"
              data-settings-search-target={settingSearchTarget(GUARD_RULE_LABELS[category])}
              key={category}>
              <PolicyOrb
                changed={(draft.guardRules ?? DEFAULT_GUARD_RULES)[category] !== policyDefaults.guardRules[category]}
              />
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
            searchTarget="guard-timeout"
            description="How long a confirmation request stays open."
            value={draft.guardTimeoutSeconds}
            disabled={controlsDisabled}
            changed={draft.guardTimeoutSeconds !== policyDefaults.guardTimeoutSeconds}
            onResetDefault={() => void save({ ...draft, guardTimeoutSeconds: policyDefaults.guardTimeoutSeconds })}
            onChange={guardTimeoutSeconds => void save({ ...draft, guardTimeoutSeconds })}
          />
          <RuntimePolicyTimeoutControl
            label="Clarify timeout"
            searchTarget="clarify-timeout"
            description="How long Pylon waits for a clarification answer."
            value={draft.clarifyTimeoutSeconds}
            disabled={controlsDisabled}
            changed={draft.clarifyTimeoutSeconds !== policyDefaults.clarifyTimeoutSeconds}
            onResetDefault={() => void save({ ...draft, clarifyTimeoutSeconds: policyDefaults.clarifyTimeoutSeconds })}
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
          <label className="settings-policy-row" data-settings-search-target="workspace">
            <PolicyOrb changed={draft.workspace !== policyDefaults.workspace} />
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
  changed,
  onReset,
  live,
  children,
}: {
  label: string;
  description?: string;
  stacked?: boolean;
  /* Undefined where the setting publishes no default, so the orb reports
     nothing rather than claiming the value is untouched. */
  changed?: boolean;
  onReset?: () => void;
  /* Some rows configure a thing that is either running or not. For those the
     orb reports that, because whether it matches a default says nothing
     useful about an agent that is switched off. */
  live?: boolean;
  children: ReactNode;
}) {
  const searchTarget = useContext(PackageSearchTargetContext);
  const target = settingSearchTarget(label);
  if (searchTarget && searchTarget !== target) return null;
  return (
    <div
      className={`package-row${stacked ? " is-stacked" : ""}`}
      data-settings-search-target={settingSearchTarget(label)}>
      <OverviewOrb
        state={live === undefined ? (changed ? "changed" : "neutral") : live ? "done" : "neutral"}
        label={live === undefined ? (changed ? "changed" : "default") : live ? "configured" : "not configured"}
      />
      <span className="package-row-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {stacked ? (
        children
      ) : (
        <span className="package-row-control">
          {changed && onReset && (
            <button className="package-row-reset" type="button" onClick={onReset}>
              Reset
            </button>
          )}
          {children}
        </span>
      )}
    </div>
  );
}

function PackageSubgroup({ label, description }: { label: string; description: string }) {
  const searchTarget = useContext(PackageSearchTargetContext);
  if (searchTarget) return null;
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
  integer = true,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  /* One place decides whether a typed or stepped value is allowed, so the
     buttons and the keyboard cannot disagree about the bounds. */
  const clamp = (next: number) => {
    if (!Number.isFinite(next)) return undefined;
    const bounded = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? Number.MIN_SAFE_INTEGER, next));
    const rounded = integer ? Math.round(bounded) : bounded;
    return Number.isSafeInteger(rounded) || !integer ? rounded : undefined;
  };
  const commit = (next: number | undefined) => {
    if (next === undefined) {
      if (input.current) input.current.value = String(value);
      return;
    }
    if (input.current) input.current.value = String(next);
    if (next !== value) onChange(next);
  };
  const nudge = (direction: 1 | -1) => commit(clamp(Number(input.current?.value ?? value) + direction * step));

  return (
    <span className={`number-field${disabled ? " is-disabled" : ""}`}>
      <input
        ref={input}
        key={value}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        disabled={disabled}
        aria-label={label}
        onBlur={event => commit(clamp(Number(event.target.value)))}
      />
      {unit && <span className="unit">{unit}</span>}
      {/* The native spinner crowds the digits and renders differently in
          every browser, so the field draws its own. */}
      <span className="number-step" aria-hidden="true">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || (max !== undefined && value >= max)}
          onClick={() => nudge(1)}>
          <IconChevronUp size={11} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || (min !== undefined && value <= min)}
          onClick={() => nudge(-1)}>
          <IconChevronDown size={11} />
        </button>
      </span>
    </span>
  );
}

function PackageChips({
  label,
  description,
  options,
  value,
  disabled,
  live,
  onChange,
}: {
  label: string;
  description: string;
  options: { value: string; label: string }[];
  value: string[];
  disabled: boolean;
  live: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <PackageRow label={label} description={description} stacked live={live}>
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

/* Only generic packages publish a defaultValue per field, so only they can
   be counted and put back. Every other kind renders "Global" as before. */
function PackageDefaultsReset({
  settings,
  disabled,
  onUpdate,
}: {
  settings?: PackageSettingsReadModel;
  disabled: boolean;
  onUpdate: (settings: PackageSettingsReadModel) => void;
}) {
  if (!settings) return <span>Global</span>;

  /* Generic packages carry a default per field; typed ones publish one map
     for the whole kind. Either way the count and the revert come from what
     the package itself says it ships with. */
  const revert =
    settings.kind === "generic"
      ? (() => {
          const changed = settings.fields.filter(field => !sameSettingValue(field.value, field.defaultValue));
          if (!changed.length) return undefined;
          return {
            count: changed.length,
            apply: () =>
              onUpdate({
                ...settings,
                fields: settings.fields.map(field => ({
                  ...field,
                  value: field.defaultValue,
                })) as typeof settings.fields,
              }),
          };
        })()
      : (() => {
          const defaults = (settings as { defaults?: Record<string, unknown> }).defaults;
          if (!defaults) return undefined;
          const live = settings as unknown as Record<string, unknown>;
          const changed = Object.keys(defaults).filter(key => !sameSettingValue(live[key], defaults[key]));
          if (!changed.length) return undefined;
          return { count: changed.length, apply: () => onUpdate({ ...settings, ...defaults }) };
        })();

  if (!revert) return <span>Global</span>;
  return (
    <button type="button" className="workbench-reset" disabled={disabled} onClick={revert.apply}>
      Reset {revert.count} setting{revert.count === 1 ? "" : "s"}
    </button>
  );
}

/* Pairs a row with the value its package ships: the orb and the reset both
   come from comparing what is set now against that default. Returns nothing
   when the package publishes no default for the key, so the row stays
   unmarked rather than claiming the value is untouched. */
function packageProvenance<S extends object>(settings: S, onUpdate: (next: S) => void) {
  /* Generic packages carry defaults per field instead, so this reads the map
     defensively rather than narrowing the settings union. */
  const defaults = (settings as { defaults?: Record<string, unknown> }).defaults;
  return (key: string) => {
    const fallback = defaults?.[key];
    if (fallback === undefined) return {};
    return {
      changed: !sameSettingValue((settings as Record<string, unknown>)[key], fallback),
      onReset: () => onUpdate({ ...settings, [key]: fallback }),
    };
  };
}

/* Settings values are primitives, string lists, or a prompt object. A
   structural compare covers all three without a per-type branch. */
function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasPackageFields(settings: PackageSettingsReadModel | undefined): boolean {
  return Boolean(settings);
}

type PromptSettingValue = { mode: "default" | "append" | "replace"; text: string };

function PromptEditor({
  label,
  value,
  defaultText,
  allowedModes,
  maxBytes = 32_768,
  disabled,
  onChange,
}: {
  label: string;
  value: PromptSettingValue;
  defaultText?: string;
  allowedModes: ReadonlyArray<PromptSettingValue["mode"]>;
  maxBytes?: number;
  disabled: boolean;
  onChange: (value: PromptSettingValue) => void;
}) {
  const byteLength = new TextEncoder().encode(value.text).byteLength;
  const customizationLabel = value.mode === "append" ? "Additional instructions" : "Replacement prompt";
  return (
    <div className="prompt-setting-editor">
      <label className="prompt-setting-mode">
        <span>Mode</span>
        <select
          aria-label={`${label} mode`}
          value={value.mode}
          disabled={disabled}
          onChange={event => {
            const mode = event.target.value as PromptSettingValue["mode"];
            onChange({ mode, text: mode === "default" ? "" : value.text });
          }}>
          {allowedModes.map(mode => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      <section className="prompt-setting-panel is-default" aria-label={`${label} default prompt preview`}>
        <header>
          <strong>Default prompt</strong>
          <span>Read only</span>
        </header>
        {defaultText !== undefined ? (
          <textarea aria-label={`${label} default prompt`} value={defaultText} readOnly rows={12} />
        ) : (
          <p className="prompt-setting-empty">
            This prompt is generated by Pi at runtime. Leave the mode on default to use the generated prompt unchanged.
          </p>
        )}
      </section>
      {value.mode !== "default" && (
        <section className="prompt-setting-panel is-custom" aria-label={`${label} ${customizationLabel.toLowerCase()}`}>
          <header>
            <strong>{customizationLabel}</strong>
            <span>{value.mode === "append" ? "Added after the default" : "Replaces the package prompt"}</span>
          </header>
          <textarea
            aria-label={label}
            value={value.text}
            disabled={disabled}
            rows={10}
            onChange={event => {
              const text = event.target.value;
              if (new TextEncoder().encode(text).byteLength <= maxBytes) onChange({ ...value, text });
            }}
          />
          <footer>
            <span>UTF-8 text</span>
            <span>
              {byteLength.toLocaleString()} / {maxBytes.toLocaleString()} bytes
            </span>
          </footer>
        </section>
      )}
    </div>
  );
}

function PromptSettingField({
  label,
  description,
  value,
  defaultText,
  allowedModes,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: PromptSettingValue;
  defaultText?: string;
  allowedModes: ReadonlyArray<PromptSettingValue["mode"]>;
  disabled: boolean;
  onChange: (value: PromptSettingValue) => void;
}) {
  return (
    <PackageRow label={label} description={description} stacked>
      <PromptEditor
        label={label}
        value={value}
        defaultText={defaultText}
        allowedModes={allowedModes}
        disabled={disabled}
        onChange={onChange}
      />
    </PackageRow>
  );
}

function GenericPackageFields({
  settings,
  models,
  disabled,
  onUpdate,
}: {
  settings: Extract<PackageSettingsReadModel, { kind: "generic" }>;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onUpdate: (settings: Extract<PackageSettingsReadModel, { kind: "generic" }>) => void;
}) {
  const hiddenModels = useHiddenModels();
  const updateField = (key: string, value: unknown) =>
    onUpdate({
      ...settings,
      fields: settings.fields.map(field => (field.key === key ? { ...field, value } : field)) as typeof settings.fields,
    });
  return (
    <div className="package-list">
      {settings.fields.map(field => {
        const description = [field.description, `Applies ${field.apply.replace("-", " ")}.`].filter(Boolean).join(" ");
        /* Generic fields ship their own defaultValue, so the row can say
           whether you moved it and put it back. Lists and prompts are
           objects, so compare by value rather than by reference. */
        const changed = !sameSettingValue(field.value, field.defaultValue);
        const resetField = () => updateField(field.key, field.defaultValue);
        if (field.type === "model") {
          const options = visibleModels(models, hiddenModels);
          const selected = models.find(model => modelKey(model) === field.value);
          if (selected && !options.some(model => modelKey(model) === field.value)) options.push(selected);
          const missing = field.value && !options.some(model => modelKey(model) === field.value);
          return (
            <PackageRow
              key={field.key}
              label={field.label}
              description={description}
              changed={changed}
              onReset={resetField}>
              <select
                aria-label={field.label}
                value={field.value}
                disabled={disabled}
                onChange={event => updateField(field.key, event.target.value)}>
                <option value="">Disabled</option>
                {missing && <option value={field.value}>{field.value}</option>}
                {options.map(model => (
                  <option value={modelKey(model)} key={modelKey(model)}>
                    {model.name}
                  </option>
                ))}
              </select>
            </PackageRow>
          );
        }

        if (field.type === "boolean") {
          return (
            <PackageRow
              key={field.key}
              label={field.label}
              description={description}
              changed={changed}
              onReset={resetField}>
              <PackageSwitch
                label={field.label}
                checked={field.value}
                disabled={disabled}
                onChange={value => updateField(field.key, value)}
              />
            </PackageRow>
          );
        }
        if (field.type === "integer" || field.type === "number") {
          return (
            <PackageRow
              key={field.key}
              label={field.label}
              description={description}
              changed={changed}
              onReset={resetField}>
              <PackageNumber
                label={field.label}
                value={field.value}
                min={field.min}
                max={field.max}
                step={field.step}
                unit={field.unit}
                integer={field.type === "integer"}
                disabled={disabled}
                onChange={value => updateField(field.key, value)}
              />
            </PackageRow>
          );
        }
        if (field.type === "enum") {
          return (
            <PackageRow
              key={field.key}
              label={field.label}
              description={description}
              changed={changed}
              onReset={resetField}>
              <select
                aria-label={field.label}
                value={field.value}
                disabled={disabled}
                onChange={event => updateField(field.key, event.target.value)}>
                {field.choices.map(choice => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </PackageRow>
          );
        }
        if (field.type === "prompt") {
          return (
            <PackageRow key={field.key} label={field.label} description={description} stacked>
              <PromptEditor
                label={field.label}
                value={field.value}
                defaultText={field.defaultText}
                allowedModes={field.allowedModes}
                maxBytes={field.maxBytes}
                disabled={disabled}
                onChange={value => updateField(field.key, value)}
              />
            </PackageRow>
          );
        }
        if (field.type !== "string-list") return null;
        return (
          <PackageRow key={field.key} label={field.label} description={description} stacked>
            <textarea
              key={field.value.join("\u0000")}
              aria-label={field.label}
              defaultValue={field.value.join(", ")}
              disabled={disabled}
              rows={2}
              onBlur={event => {
                const value = event.currentTarget.value.trim();
                updateField(field.key, value ? value.split(",").map(item => item.trim()) : []);
              }}
            />
            {field.choices && <small>Separate values with commas. Allowed: {field.choices.join(", ")}</small>}
          </PackageRow>
        );
      })}
    </div>
  );
}

const AGENT_MODEL_LABELS: Record<string, string> = {
  "pi-advisor": "Advisor",
  "pi-scout": "Scout",
  "pi-grunt": "Grunt",
  "pi-spawn": "Spawn",
  "pi-timeline": "Timeline",
  "pi-continuity": "Continuity",
  "pylon-core": "Agent naming",
};

function hasAgentModelFields(settings: PackageSettingsReadModel | undefined): boolean {
  if (!settings) return false;
  if (settings.kind === "generic") {
    return settings.packageId === "pylon-core" && settings.fields.some(field => field.key === "delegateNamingModel");
  }
  return ["advisor", "scout", "grunt", "spawn", "timeline", "continuity"].includes(settings.kind);
}

function AgentModelSettings({
  packages,
  models,
  sessionThinkingLevels,
  loading,
  disabled,
  onUpdate,
}: {
  packages: PackageSummary[];
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  loading: boolean;
  disabled: boolean;
  onUpdate: (item: PackageSummary, settings: PackageSettingsReadModel) => void;
}) {
  if (loading && packages.length === 0) return <div className="settings-empty">Detecting agent settings…</div>;
  if (packages.length === 0) {
    return (
      <div className="settings-empty">
        <strong>No configurable agent models</strong>
        <span>Install or enable a supported package first.</span>
      </div>
    );
  }
  return (
    <div className="agent-model-groups">
      {packages.map(item => (
        <section className="agent-model-group" key={item.id}>
          <header>
            <h3>{AGENT_MODEL_LABELS[item.id] ?? item.name}</h3>
            {!item.enabled && <span>Package disabled</span>}
          </header>
          <div className="package-list">
            <PackageModelFields
              settings={item.settings!}
              models={models}
              sessionThinkingLevels={sessionThinkingLevels}
              disabled={disabled}
              onUpdate={settings => onUpdate(item, settings)}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

function PackageModelFields({
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
  const hiddenModels = useHiddenModels();
  const provenance = packageProvenance(settings, onUpdate);

  if (settings.kind === "generic") {
    const field = settings.fields.find(candidate => candidate.key === "delegateNamingModel");
    if (!field || field.type !== "model") return null;
    return (
      <PackageRow
        live={Boolean(field.value)}
        label="Naming model"
        description="Assigns short semantic names to delegated agents. Applies next session.">
        <OptionalModelSelect
          label="Agent naming model"
          value={field.value}
          models={models}
          disabled={disabled}
          onChange={value =>
            onUpdate({
              ...settings,
              fields: settings.fields.map(candidate =>
                candidate.key === field.key ? { ...candidate, value } : candidate,
              ) as typeof settings.fields,
            })
          }
        />
      </PackageRow>
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
      <>
        <PackageRow
          live={settings.mode !== "disabled"}
          label="Model"
          description={`Disabled turns ${noun} off for every session.`}>
          <ModelModeSelect
            label={`${settings.kind} model`}
            value={settings.mode === "model" ? settings.model! : settings.mode}
            models={models}
            disabled={disabled}
            onChange={value => onUpdate({ ...settings, ...modelModeUpdate(value) })}
          />
        </PackageRow>
        <PackageRow
          live={settings.thinking !== undefined}
          label="Thinking"
          description="Inherits the session level unless set here.">
          <ThinkingSelect
            label={`${settings.kind} thinking`}
            value={settings.thinking}
            levels={levels}
            disabled={disabled || settings.mode === "disabled"}
            onChange={thinking => onUpdate({ ...settings, thinking })}
          />
        </PackageRow>
      </>
    );
  }

  if (settings.kind === "grunt") {
    const thinkingOptions = thinkingChipOptions();
    return (
      <>
        <PackageRow
          live={settings.mode !== "disabled"}
          label="Model"
          description="Disabled turns the grunt off for every session.">
          <ModelModeSelect
            label="Grunt model"
            value={settings.mode === "model" ? settings.model! : settings.mode}
            models={models}
            disabled={disabled}
            onChange={value => onUpdate({ ...settings, ...modelModeUpdate(value) })}
          />
        </PackageRow>
        <PackageChips
          label="Eligible thinking levels"
          description="Levels a grunt run may use. At least one stays selected."
          options={thinkingOptions}
          value={settings.thinkingLevels}
          disabled={disabled}
          live={settings.thinkingLevels.length < thinkingOptions.length}
          onChange={levels => onUpdate({ ...settings, thinkingLevels: levels as ThinkingLevelReadModel[] })}
        />
      </>
    );
  }

  if (settings.kind === "timeline") {
    return (
      <PackageRow
        live={settings.checkpointTitleMode !== "disabled"}
        label="Timeline titles"
        description="Generate semantic checkpoint and session titles with the session model or a selected model.">
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
    );
  }

  if (settings.kind === "continuity") {
    return (
      <>
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
      </>
    );
  }

  if (settings.kind === "spawn") {
    const available = visibleModels(models, hiddenModels).map(model => ({ value: modelKey(model), label: model.name }));
    const eligible = settings.models;
    const options = [
      ...available,
      ...(eligible ?? [])
        .filter(ref => !available.some(model => model.value === ref))
        .map(ref => ({ value: ref, label: ref })),
    ];
    const thinkingOptions = thinkingChipOptions();
    return (
      <>
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
          live={eligible !== undefined && eligible.length < options.length}
          onChange={next => onUpdate({ ...settings, models: next })}
        />
        <PackageChips
          label="Private-agent thinking"
          description="Thinking levels a private agent may be spawned with."
          options={thinkingOptions}
          value={settings.agentThinkingLevels}
          disabled={disabled}
          live={settings.agentThinkingLevels.length < thinkingOptions.length}
          onChange={levels => onUpdate({ ...settings, agentThinkingLevels: levels as ThinkingLevelReadModel[] })}
        />
      </>
    );
  }

  return null;
}

interface PackageFieldsProps {
  settings: PackageSettingsReadModel;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  disabled: boolean;
  onUpdate: (settings: PackageSettingsReadModel) => void;
  searchTarget?: string;
}

function PackageFields({ searchTarget, ...props }: PackageFieldsProps) {
  return (
    <PackageSearchTargetContext.Provider value={searchTarget}>
      <PackageFieldsContent {...props} />
    </PackageSearchTargetContext.Provider>
  );
}

function PackageFieldsContent({
  settings,
  models,
  sessionThinkingLevels,
  disabled,
  onUpdate,
}: Omit<PackageFieldsProps, "searchTarget">) {
  const searchTarget = useContext(PackageSearchTargetContext);
  const provenance = packageProvenance(settings, onUpdate);
  if (settings.kind === "generic") {
    return <GenericPackageFields settings={settings} models={models} disabled={disabled} onUpdate={onUpdate} />;
  }

  if (settings.kind === "timeline") {
    return (
      <div className="package-list">
        <PackageModelFields
          settings={settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <PromptSettingField
          label="Timeline naming instructions"
          description="Appended to session and checkpoint naming prompts next session. Output contracts remain fixed."
          value={settings.prompt}
          defaultText={settings.promptDefaultText}
          allowedModes={["default", "append"]}
          disabled={disabled}
          onChange={prompt => onUpdate({ ...settings, prompt })}
        />
        <PackageRow
          {...provenance("gitTimeoutMs")}
          label="Git timeout"
          description="Maximum time for each Timeline git operation. Applies to the next session.">
          <PackageNumber
            label="Git timeout"
            value={settings.gitTimeoutMs}
            min={1_000}
            max={600_000}
            step={1_000}
            unit="ms"
            disabled={disabled}
            onChange={gitTimeoutMs => onUpdate({ ...settings, gitTimeoutMs })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("titleTimeoutMs")}
          label="Title generation timeout"
          description="Maximum time for each session or checkpoint title call. Applies to the next session.">
          <PackageNumber
            label="Title generation timeout"
            value={settings.titleTimeoutMs}
            min={1_000}
            max={300_000}
            step={1_000}
            unit="ms"
            disabled={disabled}
            onChange={titleTimeoutMs => onUpdate({ ...settings, titleTimeoutMs })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("titleMaxTokens")}
          label="Title maximum output"
          description="Maximum tokens generated for a Timeline title. Applies to the next session.">
          <PackageNumber
            label="Title maximum output"
            value={settings.titleMaxTokens}
            min={8}
            max={256}
            unit="tokens"
            disabled={disabled}
            onChange={titleMaxTokens => onUpdate({ ...settings, titleMaxTokens })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("titleChangedFiles")}
          label="Changed files in title prompt"
          description="Maximum changed-file paths supplied to checkpoint title generation. Applies to the next session.">
          <PackageNumber
            label="Changed files in title prompt"
            value={settings.titleChangedFiles}
            min={1}
            max={200}
            unit="files"
            disabled={disabled}
            onChange={titleChangedFiles => onUpdate({ ...settings, titleChangedFiles })}
          />
        </PackageRow>
        {!searchTarget && (
          <p className="settings-callout">
            <IconAlertTriangle size={18} aria-hidden="true" />
            <span>
              <strong>Checkpoint naming creates an extra model call for each changed turn.</strong>
              Use a cheap model to keep Timeline costs low.
            </span>
          </p>
        )}
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
    return (
      <div className="package-list">
        <PackageModelFields
          settings={settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <PromptSettingField
          label={`${settings.kind === "advisor" ? "Advisor" : "Scout"} system prompt`}
          description="Append to or replace the package-owned prompt on the next operation. Immutable safety and output contracts remain fixed."
          value={settings.prompt}
          defaultText={settings.promptDefaultText}
          allowedModes={["default", "append", "replace"]}
          disabled={disabled}
          onChange={prompt => onUpdate({ ...settings, prompt })}
        />
        {settings.kind === "advisor" && (
          <>
            <PackageRow
              {...provenance("maxCalls")}
              label="Maximum consultations"
              description="Maximum Advisor calls for each original user prompt.">
              <PackageNumber
                label="Maximum consultations"
                value={settings.maxCalls}
                min={1}
                max={10}
                disabled={disabled}
                onChange={maxCalls => onUpdate({ ...settings, maxCalls })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("timeoutMs")}
              label="Consultation timeout"
              description="Stops an Advisor consultation after this duration.">
              <PackageNumber
                label="Consultation timeout"
                value={settings.timeoutMs}
                min={1_000}
                max={7_200_000}
                step={1_000}
                unit="ms"
                disabled={disabled}
                onChange={timeoutMs => onUpdate({ ...settings, timeoutMs })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("maxCostUsd")}
              label="Maximum consultation cost"
              description="Stops an Advisor consultation when this cost limit is reached.">
              <PackageNumber
                label="Maximum consultation cost"
                value={settings.maxCostUsd}
                min={0.01}
                max={100}
                step={0.01}
                unit="USD"
                integer={false}
                disabled={disabled}
                onChange={maxCostUsd => onUpdate({ ...settings, maxCostUsd })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("maxOutputTokens")}
              label="Maximum output tokens"
              description="Caps each Advisor response.">
              <PackageNumber
                label="Maximum output tokens"
                value={settings.maxOutputTokens}
                min={256}
                max={65_536}
                unit="tokens"
                disabled={disabled}
                onChange={maxOutputTokens => onUpdate({ ...settings, maxOutputTokens })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("inputTokenBudget")}
              label="Input context budget"
              description="Caps the Advisor snapshot input token budget.">
              <PackageNumber
                label="Input context budget"
                value={settings.inputTokenBudget}
                min={1_000}
                max={1_000_000}
                step={1_000}
                unit="tokens"
                disabled={disabled}
                onChange={inputTokenBudget => onUpdate({ ...settings, inputTokenBudget })}
              />
            </PackageRow>
          </>
        )}
        {settings.kind === "scout" && (
          <>
            <PackageRow
              {...provenance("repoTimeoutMs")}
              label="Repository scout timeout"
              description="Stops a repository scout run after this duration.">
              <PackageNumber
                label="Repository scout timeout"
                value={settings.repoTimeoutMs}
                min={1}
                max={7_200_000}
                step={1_000}
                unit="ms"
                disabled={disabled}
                onChange={repoTimeoutMs => onUpdate({ ...settings, repoTimeoutMs })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("maxCostUsd")}
              label="Maximum scout cost"
              description="Set to 0 for no cost limit.">
              <PackageNumber
                label="Maximum scout cost"
                value={settings.maxCostUsd}
                min={0}
                max={100}
                step={0.01}
                unit="USD"
                integer={false}
                disabled={disabled}
                onChange={maxCostUsd => onUpdate({ ...settings, maxCostUsd })}
              />
            </PackageRow>
            <PackageRow
              {...provenance("webSearchResults")}
              label="Web search results"
              description="Default URL candidates returned by each Web Scout search.">
              <PackageNumber
                label="Web search results"
                value={settings.webSearchResults}
                min={1}
                max={8}
                unit="results"
                disabled={disabled}
                onChange={webSearchResults => onUpdate({ ...settings, webSearchResults })}
              />
            </PackageRow>
          </>
        )}
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
        <PackageModelFields
          settings={settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <PromptSettingField
          label="Grunt system prompt"
          description="Append to or replace the selected worker-mode prompt on the next operation. Execution safety remains fixed."
          value={settings.prompt}
          defaultText={settings.promptDefaultText}
          allowedModes={["default", "append", "replace"]}
          disabled={disabled}
          onChange={prompt => onUpdate({ ...settings, prompt })}
        />
        <PackageRow
          {...provenance("executionMode")}
          label="Execution mode"
          description="Isolated runs in a scratch workspace; direct runs in place.">
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
          {...provenance("timeoutMs")}
          label="Worker timeout"
          description="Stops a worker run after this duration.">
          <PackageNumber
            label="Worker timeout"
            value={settings.timeoutMs}
            min={1}
            max={7_200_000}
            step={1_000}
            unit="ms"
            disabled={disabled}
            onChange={timeoutMs => onUpdate({ ...settings, timeoutMs })}
          />
        </PackageRow>

        <PackageRow
          {...provenance("maxTurns")}
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
        <PackageRow
          {...provenance("maxCostUsd")}
          label="Maximum worker cost"
          description="Stops a worker run when this cost limit is reached.">
          <PackageNumber
            label="Maximum worker cost"
            value={settings.maxCostUsd}
            min={0.01}
            max={100}
            step={0.01}
            unit="USD"
            integer={false}
            disabled={disabled}
            onChange={maxCostUsd => onUpdate({ ...settings, maxCostUsd })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("parentContextChars")}
          label="Parent context"
          description="Include up to this many characters of parent-session context in each worker handoff.">
          <PackageNumber
            label="Parent context"
            value={settings.parentContextChars}
            min={0}
            max={12_000}
            step={100}
            unit="characters"
            disabled={disabled}
            onChange={parentContextChars => onUpdate({ ...settings, parentContextChars })}
          />
        </PackageRow>
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
          {...provenance("reserveTokens")}
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
          {...provenance("keepRecentTokens")}
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
        <PackageRow
          {...provenance("compactionReviewTimeoutMs")}
          label="Compaction review timeout"
          description="Maximum time for a compaction reviewer call. Applies to the next review.">
          <PackageNumber
            label="Compaction review timeout"
            value={settings.compactionReviewTimeoutMs}
            min={1_000}
            max={300_000}
            step={1_000}
            unit="ms"
            disabled={disabled}
            onChange={compactionReviewTimeoutMs => onUpdate({ ...settings, compactionReviewTimeoutMs })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("compactionReviewerMaxOutputTokens")}
          label="Compaction reviewer maximum output"
          description="Maximum tokens generated by the compaction reviewer. Applies to the next review.">
          <PackageNumber
            label="Compaction reviewer maximum output"
            value={settings.compactionReviewerMaxOutputTokens}
            min={256}
            max={8_192}
            unit="tokens"
            disabled={disabled}
            onChange={compactionReviewerMaxOutputTokens => onUpdate({ ...settings, compactionReviewerMaxOutputTokens })}
          />
        </PackageRow>
        <PackageSubgroup
          label="Agent profiles"
          description="Each profile picks a model and a thinking level. Unset profiles fall back to the session model."
        />
        <PackageModelFields
          settings={settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <PromptSettingField
          label="Continuity reviewer instructions"
          description="Appended to memory review and migration prompts on the next operation. Security and JSON contracts remain fixed."
          value={settings.prompt}
          defaultText={settings.promptDefaultText}
          allowedModes={["default", "append"]}
          disabled={disabled}
          onChange={prompt => onUpdate({ ...settings, prompt })}
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
          {...provenance("projectionMode")}
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
        <PackageRow
          {...provenance("threshold")}
          label="Pruning threshold"
          description="Results larger than this are eligible for pruning.">
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
              {...provenance("rolloverHighMultiplier")}
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
              {...provenance("rolloverLowMultiplier")}
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
    return (
      <div className="package-list">
        <PackageModelFields
          settings={settings}
          models={models}
          sessionThinkingLevels={sessionThinkingLevels}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <PromptSettingField
          label="Private-agent default system prompt"
          description="Used for a new private agent only when the spawn call omits systemPrompt. Applies next operation."
          value={settings.privateAgentSystemPrompt}
          allowedModes={["default", "append", "replace"]}
          defaultText={settings.promptDefaultText}
          disabled={disabled}
          onChange={privateAgentSystemPrompt => onUpdate({ ...settings, privateAgentSystemPrompt })}
        />
        <PackageRow
          {...provenance("spawnTimeoutMs")}
          label="Spawn timeout"
          description="Maximum child runtime. Set to 0 for unlimited.">
          <PackageNumber
            label="Spawn timeout"
            value={settings.spawnTimeoutMs}
            min={0}
            max={7_200_000}
            step={1_000}
            unit="ms"
            integer
            disabled={disabled}
            onChange={spawnTimeoutMs => onUpdate({ ...settings, spawnTimeoutMs })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("recentThreadLimit")}
          label="Recent thread message limit"
          description="Default number of transcript messages returned by recent.">
          <PackageNumber
            label="Recent thread message limit"
            value={settings.recentThreadLimit}
            min={1}
            max={50}
            integer
            disabled={disabled}
            onChange={recentThreadLimit => onUpdate({ ...settings, recentThreadLimit })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("recentThreadMaxChars")}
          label="Recent thread message characters"
          description="Default maximum characters per transcript message.">
          <PackageNumber
            label="Recent thread message characters"
            value={settings.recentThreadMaxChars}
            min={100}
            max={10_000}
            step={100}
            unit="characters"
            integer
            disabled={disabled}
            onChange={recentThreadMaxChars => onUpdate({ ...settings, recentThreadMaxChars })}
          />
        </PackageRow>
        <PackageRow
          {...provenance("recentThreadTotalChars")}
          label="Recent thread total characters"
          description="Maximum total characters returned by recent.">
          <PackageNumber
            label="Recent thread total characters"
            value={settings.recentThreadTotalChars}
            min={1_000}
            max={100_000}
            step={1_000}
            unit="characters"
            integer
            disabled={disabled}
            onChange={recentThreadTotalChars => onUpdate({ ...settings, recentThreadTotalChars })}
          />
        </PackageRow>
      </div>
    );
  }
  return null;
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
  const options = selectableModels(models, hiddenModels, [value]);
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

function OptionalModelSelect({
  label,
  emptyLabel = "Disabled",
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  emptyLabel?: string;
  value?: string;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const hiddenModels = useHiddenModels();
  const options = selectableModels(models, hiddenModels, value ? [value] : []);
  const missing = value && !options.some(model => modelKey(model) === value);
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {missing && <option value={value}>{value}</option>}
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
      <OverviewOrb
        state={profile?.model ? "done" : "neutral"}
        label={profile?.model ? "configured" : "not configured"}
      />
      <span className="package-row-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="package-row-control is-pair">
        <OptionalModelSelect
          label={`${label} model`}
          emptyLabel="Not configured"
          value={profile?.model}
          models={models}
          disabled={disabled}
          onChange={model => onChange(model ? { model } : undefined)}
        />
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
