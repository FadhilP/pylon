import { IconChevronRight, IconExternalLink, IconKey, IconLogout, IconSettings, IconStack2, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { DEFAULT_GUARD_RULES, GUARD_ACTIONS, GUARD_RISK_CATEGORIES, GUARD_RULE_DESCRIPTIONS, GUARD_RULE_LABELS } from "../shared/guard-policy";
import type { ModelOptionReadModel, ProviderAuthReadModel, ProviderAuthType, ThinkingLevelReadModel, ToolPolicyReadModel, UiRequestReadModel } from "../shared/protocol/events";
import type { HookSettingsReadModel, PackageSettingsReadModel, PackageSummary, RuntimePolicyReadModel, ToolExposureMode } from "../shared/protocol/snapshots";
import { thinkingLabel } from "./format";
import { HookSettingsFields } from "./hook-settings-fields";
import { RuntimePolicyTimeoutControl } from "./runtime-policy-timeout";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";
import { UiDialog } from "./ui-dialog";

export type SettingsTab = "providers" | "packages" | "hooks" | "policy" | "notifications" | "appearance";
type SettingsTheme = "light" | "dark";
const SETTINGS_TABS: SettingsTab[] = ["providers", "packages", "hooks", "policy", "notifications", "appearance"];
const PACKAGE_THINKING_LEVELS: ThinkingLevelReadModel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface SettingsDialogProps {
  initialTab?: SettingsTab;
  initialProviderQuery?: string;
  initialPackageQuery?: string;
  providerAuth?: ProviderAuthReadModel;
  pendingUi?: UiRequestReadModel;
  packages: PackageSummary[];
  hookSettings?: HookSettingsReadModel;
  runtimePolicy?: RuntimePolicyReadModel;
  toolPolicies: ToolPolicyReadModel[];
  policyDisabled: boolean;
  loading: boolean;
  hookLoading: boolean;
  busy: string;
  hookBusy: boolean;
  providerLogoutDisabled: boolean;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  theme: SettingsTheme;
  onThemeChange: (theme: SettingsTheme) => void;
  onClose: () => void;
  onProviderLogin: (provider: string, authType: ProviderAuthType) => void;
  onProviderLogout: (provider: string) => void;
  onProviderCancel: () => void;
  onSetEnabled: (item: PackageSummary, enabled: boolean) => void;
  onUpdate: (item: PackageSummary, settings: PackageSettingsReadModel) => void;
  onUpdateHooks: (settings: HookSettingsReadModel) => Promise<void>;
  onUpdateGlobalPolicy: (settings: RuntimePolicyReadModel["global"], expectedRevision: number) => Promise<void>;
  onUpdateGlobalToolPolicy: (tool: string, mode: ToolExposureMode | "inherit", expectedRevision: number) => Promise<void>;
}

export function SettingsDialog({ initialTab = "packages", initialProviderQuery = "", initialPackageQuery = "", providerAuth, pendingUi, packages, hookSettings, runtimePolicy, toolPolicies, policyDisabled, loading, hookLoading, busy, hookBusy, providerLogoutDisabled, models, sessionThinkingLevels, theme, onThemeChange, onClose, onProviderLogin, onProviderLogout, onProviderCancel, onSetEnabled, onUpdate, onUpdateHooks, onUpdateGlobalPolicy, onUpdateGlobalToolPolicy }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [providerQuery, setProviderQuery] = useState(initialProviderQuery);
  const [packageQuery, setPackageQuery] = useState(initialPackageQuery);
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [toolPolicyBusy, setToolPolicyBusy] = useState("");
  const filteredPackages = packages.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(packageQuery.trim().toLowerCase()));
  const providers = providerAuth?.providers ?? [];
  const filteredProviders = providers
    .filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const providerGroups = [
    { id: "connected", label: "Connected", providers: filteredProviders.filter((provider) => provider.configured) },
    { id: "available", label: "Available", providers: filteredProviders.filter((provider) => !provider.configured) },
  ];
  const authFlow = providerAuth?.flow;
  const authRunning = authFlow?.status === "running";
  const providerPrompt = pendingUi?.payload.context === "provider-auth" ? pendingUi : undefined;
  const primaryAuthLink = authFlow?.deviceCode
    ? { url: authFlow.deviceCode.verificationUri, label: "Open verification page" }
    : authFlow?.authUrl
      ? { url: authFlow.authUrl, label: "Open sign-in page" }
      : authFlow?.links?.[0];
  const secondaryAuthLinks = authFlow?.links?.filter((link, index, links) =>
    link.url !== primaryAuthLink?.url && links.findIndex((candidate) => candidate.url === link.url) === index) ?? [];
  const authRetryable = authFlow?.status === "failed" || authFlow?.status === "cancelled";

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
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
    const focusable = [...dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])") ?? []]
      .filter((element) => !element.closest("[hidden]"));
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
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SETTINGS_TABS.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(SETTINGS_TABS[next]!);
    dialogRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };

  const selectedPackage = filteredPackages.find((item) => item.id === selectedPackageId) ?? filteredPackages[0];
  const selectedToolPolicy = selectedPackage ? toolPolicies.find((policy) => policy.owner === selectedPackage.id) : undefined;
  const selectedTools = selectedToolPolicy?.managedTools ?? [];

  return <div className="settings-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onKeyDown={onKeyDown}>
      <header>
        <div><IconSettings size={18} /><strong id="settings-dialog-title">Settings</strong><span>Manage Pylon defaults and integrations</span></div>
        <button data-autofocus className="icon-button" type="button" onClick={onClose} aria-label="Close settings"><IconX size={17} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <div role="tablist">
            {SETTINGS_TABS.map((tab, index) => <button
              key={tab}
              id={`settings-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`settings-panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >{tab}</button>)}
          </div>
        </nav>

        <div className={`settings-content${activeTab === "packages" ? " is-packages" : ""}`}>
          <section id="settings-panel-providers" className="settings-pane" role="tabpanel" aria-labelledby="settings-tab-providers" hidden={activeTab !== "providers"}>
            <div className="settings-pane-header">
              <div><h2>Providers</h2><p>Connect accounts and API keys used by Pi. Credentials stay on this machine.</p></div>
              <input type="search" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="Filter providers" aria-label="Filter providers" />
            </div>
            {(authFlow || providerPrompt) && <section className={`provider-auth-task is-${authFlow?.status ?? "running"}`} aria-labelledby="provider-auth-title">
              <header>
                <h3 id="provider-auth-title">{authFlow?.providerName ?? "Provider authentication"}</h3>
                <p className="provider-auth-status" role={authFlow?.status === "failed" ? "alert" : "status"}>{authFlow?.message ?? "Authentication requires a response."}</p>
                {authFlow?.instructions && authFlow.instructions !== authFlow.message && <p className="provider-auth-instructions">{authFlow.instructions}</p>}
              </header>
              <div className="provider-auth-actions">
                {primaryAuthLink && <a className="provider-auth-primary" href={primaryAuthLink.url} target="_blank" rel="noopener noreferrer">{primaryAuthLink.label ?? "Open provider page"} <IconExternalLink size={15} /><span className="sr-only"> (opens in a new tab)</span></a>}
                {authRetryable && authFlow && <button type="button" className="provider-auth-retry" onClick={() => onProviderLogin(authFlow.providerId, authFlow.authType)}>Try again</button>}
                {authRunning && <button type="button" className="provider-auth-cancel" onClick={onProviderCancel}>Cancel</button>}
              </div>
              {authFlow?.deviceCode && <div className="provider-device-code">
                <span>One-time code</span>
                <code>{authFlow.deviceCode.userCode}</code>
              </div>}
              {secondaryAuthLinks.length > 0 && <div className="provider-auth-links">{secondaryAuthLinks.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label ?? "Open provider page"} <IconExternalLink size={14} /><span className="sr-only"> (opens in a new tab)</span></a>)}</div>}
              {providerPrompt && <div className="provider-auth-manual"><UiDialog request={providerPrompt} /></div>}
            </section>}
            {providers.length === 0 && <div className="settings-empty"><IconKey size={22} /><strong>No providers available</strong></div>}
            {providers.length > 0 && filteredProviders.length === 0 && <div className="settings-empty"><strong>No matching providers</strong><span>Try a different filter.</span></div>}
            {filteredProviders.length > 0 && <div className="settings-provider-groups">{providerGroups.map((group) => group.providers.length > 0 && <section className="settings-provider-group" key={group.id} aria-labelledby={`provider-group-${group.id}`}>
              <header><h3 id={`provider-group-${group.id}`}>{group.label}</h3><span>{group.providers.length}</span></header>
              <div className="settings-provider-list">{group.providers.map((provider) => <section className="settings-provider" key={provider.id}>
                <div className="settings-provider-copy"><span><strong>{provider.name}</strong><small>{provider.id}</small></span></div>
                <span className={`provider-state${provider.configured ? " is-connected" : ""}`}>{provider.configured ? provider.stored ? "Connected" : "External" : "Not connected"}</span>
                <div className="provider-actions">
                  {!provider.configured && provider.methods.map((method) => method.interactive
                    ? <button
                        key={method.type}
                        type="button"
                        disabled={authRunning}
                        onClick={() => onProviderLogin(provider.id, method.type)}
                      >{method.type === "oauth" ? "Sign in" : "Add key"}</button>
                    : <span className="provider-action-note" key={method.type} title={method.name}>Configured outside Pylon</span>)}
                  {provider.configured && provider.stored && <button className="provider-disconnect" type="button" disabled={providerLogoutDisabled || authRunning} onClick={() => onProviderLogout(provider.id)}><IconLogout size={14} /> Disconnect</button>}
                </div>
              </section>)}</div>
            </section>)}</div>}
            {providerLogoutDisabled && <p className="settings-note" role="status">Providers can disconnect when every active session is idle.</p>}
          </section>

          <section id="settings-panel-packages" className="settings-pane packages-workbench-pane" role="tabpanel" aria-labelledby="settings-tab-packages" hidden={activeTab !== "packages"}>
            <div className="settings-pane-header">
              <div><h2>Packages</h2><p>Configure package defaults and global tool exposure from one workbench.</p></div>
              <input type="search" value={packageQuery} onChange={(event) => setPackageQuery(event.target.value)} placeholder="Filter packages" aria-label="Filter packages" />
            </div>
            {loading && packages.length === 0 && <div className="settings-empty">Detecting packages…</div>}
            {!loading && packages.length === 0 && <div className="settings-empty"><IconStack2 size={22} /><strong>No local Pi packages</strong></div>}
            {!loading && packages.length > 0 && filteredPackages.length === 0 && <div className="settings-empty"><strong>No matching packages</strong><span>Try a different filter.</span></div>}
            {selectedPackage && <div className="package-workbench">
              <aside className="package-workbench-index" aria-label="Packages">
                {filteredPackages.map((item) => {
                  const state = item.error ? "failed" : item.active ? "active" : item.enabled ? "unavailable" : "disabled";
                  return <button type="button" className={item.id === selectedPackage.id ? "is-selected" : ""} onClick={() => setSelectedPackageId(item.id)} key={item.id}>
                    <span><strong>{item.name}</strong><small>{toolPolicies.find((policy) => policy.owner === item.id)?.managedTools.length ?? 0} tools</small></span>
                    <b className={`package-state is-${state}`}>{state}</b>
                  </button>;
                })}
              </aside>
              <article className="package-workbench-detail">
                <header>
                  <div><h3>{selectedPackage.name}</h3><p>{selectedPackage.description || `${selectedPackage.extensionCount} Pi extension${selectedPackage.extensionCount === 1 ? "" : "s"}`}</p></div>
                  {selectedPackage.required ? <span className="package-required">Required</span> : <label className="package-switch"><span className="sr-only">Toggle {selectedPackage.name}</span><input type="checkbox" role="switch" checked={selectedPackage.enabled} disabled={Boolean(busy)} onChange={(event) => onSetEnabled(selectedPackage, event.target.checked)} /></label>}
                </header>
                {selectedPackage.error && <p className="package-error">{selectedPackage.error}</p>}
                <section className="workbench-section">
                  <header><div><h4>Package defaults</h4><p>Configuration owned by this package.</p></div><span>Global</span></header>
                  {hasPackageFields(selectedPackage.settings) && selectedPackage.settings
                    ? <PackageFields settings={selectedPackage.settings} models={models} sessionThinkingLevels={sessionThinkingLevels} disabled={Boolean(busy)} onUpdate={(settings) => onUpdate(selectedPackage, settings)} />
                    : <p className="workbench-empty">This package has no configurable defaults.</p>}
                </section>
                <section className="workbench-section">
                  <header><div><h4>Tool exposure</h4><p>Defaults used when a project or session does not override them.</p></div><span>Global</span></header>
                  {selectedTools.length ? <div className="workbench-tool-list">{selectedTools.map((tool) => {
                    const capable = selectedToolPolicy?.enabledTools.includes(tool) === true;
                    const packageDefault = selectedToolPolicy?.deferredTools.includes(tool) ? "deferred" : capable ? "active" : "disabled";
                    const override = runtimePolicy?.global.toolOverrides?.[tool];
                    const effective = capable ? override ?? packageDefault : "disabled";
                    const locked = tool === "search_tools";
                    return <label className="workbench-tool-row" data-effective={effective} key={tool}>
                      <span><strong>{tool}</strong></span>
                      <span className="workbench-tool-effective" aria-label={`Current setting: ${effective}`}><i aria-hidden="true" /><strong>{effective}</strong></span>
                      <select value={override ?? "inherit"} disabled={locked || policyDisabled || toolPolicyBusy === tool || (!capable && !override)} onChange={(event) => {
                        if (!runtimePolicy) return;
                        const mode = event.target.value as ToolExposureMode | "inherit";
                        setToolPolicyBusy(tool);
                        void onUpdateGlobalToolPolicy(tool, mode, runtimePolicy.revision).finally(() => setToolPolicyBusy(""));
                      }}>
                        <option value="inherit">Default</option><option value="active" disabled={!capable}>Active</option><option value="deferred" disabled={!capable}>Deferred</option><option value="disabled" disabled={!capable}>Disabled</option>
                      </select>
                    </label>;
                  })}</div> : <p className="workbench-empty">This package does not publish tool policy.</p>}
                </section>
              </article>
            </div>}
          </section>

          <section id="settings-panel-hooks" className="settings-pane hooks-pane" role="tabpanel" aria-labelledby="settings-tab-hooks" hidden={activeTab !== "hooks"}>
            <div className="settings-pane-header"><div><h2>Hooks</h2><p>Add workspace instructions at two predictable points in the agent lifecycle. Import Markdown or text snapshots, or write instructions directly.</p></div></div>
            <HookSettingsFields settings={hookSettings} loading={hookLoading} disabled={hookBusy} onUpdate={onUpdateHooks} />
          </section>

          <section id="settings-panel-policy" className="settings-pane global-policy-pane" role="tabpanel" aria-labelledby="settings-tab-policy" hidden={activeTab !== "policy"}>
            <GlobalPolicySettings policy={runtimePolicy} disabled={policyDisabled} onUpdate={onUpdateGlobalPolicy} />
          </section>

          <section id="settings-panel-notifications" className="settings-pane" role="tabpanel" aria-labelledby="settings-tab-notifications" hidden={activeTab !== "notifications"}>
            <div className="settings-pane-header"><div><h2>Notifications</h2><p>Preview the cues Pylon uses when work finishes or needs your attention.</p></div></div>
            <h3>Sound cues</h3>
            <div className="settings-option-list">
              <div><span><strong>Turn complete</strong><small>Played after the assistant finishes a turn.</small></span><button type="button" onClick={() => playSound("turn-complete")}>Play preview</button></div>
              <div><span><strong>Attention required</strong><small>Played when Pylon needs approval or clarification.</small></span><button type="button" onClick={() => playSound("attention")}>Play preview</button></div>
            </div>
          </section>

          <section id="settings-panel-appearance" className="settings-pane" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={activeTab !== "appearance"}>
            <div className="settings-pane-header"><div><h2>Appearance</h2><p>Choose the color theme used throughout Pylon.</p></div></div>
            <h3>Color theme</h3>
            <div className="settings-theme-options">
              {(["dark", "light"] as const).map((option) => <label key={option}>
                <input type="radio" name="settings-theme" value={option} checked={theme === option} onChange={() => onThemeChange(option)} />
                <span className={`theme-preview is-${option}`} aria-hidden="true"><i /><i /></span>
                <strong>{option}</strong>
              </label>)}
            </div>
          </section>
        </div>
      </div>
      <footer><span>Changes save immediately</span><button type="button" onClick={onClose}>Done</button></footer>
    </div>
  </div>;
}

const defaultGlobalPolicy: RuntimePolicyReadModel["global"] = {
  timelineEnabled: true,
  guardEnabled: true,
  guardRules: { ...DEFAULT_GUARD_RULES },
  workspace: "local",
  guardTimeoutSeconds: 60,
  clarifyTimeoutSeconds: 60,
};

function GlobalPolicySettings({ policy, disabled, onUpdate }: {
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

  if (!policy) return <div className="settings-empty"><strong>Global policy unavailable</strong><span>Connect to a registered project to edit policy defaults.</span></div>;

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

  return <>
    <div className="settings-pane-header">
      <div><h2>Global policy defaults</h2><p>Set the starting behavior for every project and session. Existing project and session overrides stay unchanged. Verify is configured per project in Inspector.</p></div>
    </div>

    <div className="policy-inheritance" aria-label="Policy inheritance order">
      <span><strong>Global</strong><i aria-hidden="true">›</i><b>Project</b><i aria-hidden="true">›</i><b>Session</b></span>
      <small>The nearest override wins. Inherited values update when their source changes.</small>
    </div>

    <section className="settings-policy-group" aria-labelledby="global-policy-safety-title">
      <header><h3 id="global-policy-safety-title">Activity and safety</h3><p>Defaults for checkpoints, approvals, and response windows.</p></header>
      <div className="settings-policy-list">
        <div className="settings-policy-row">
          <span><strong>Timeline</strong><small>Keep recoverable checkpoints for session activity.</small></span>
          <label className="settings-policy-switch"><input type="checkbox" role="switch" checked={draft.timelineEnabled} disabled={controlsDisabled} onChange={(event) => void save({ ...draft, timelineEnabled: event.target.checked })} /><span aria-hidden="true" /><small>{draft.timelineEnabled ? "Enabled" : "Disabled"}</small></label>
        </div>
        <div className="settings-policy-row">
          <span><strong>Guard</strong><small>Ask before guarded commands and paths run.</small></span>
          <label className="settings-policy-switch"><input type="checkbox" role="switch" checked={draft.guardEnabled} disabled={controlsDisabled} onChange={(event) => void save({ ...draft, guardEnabled: event.target.checked })} /><span aria-hidden="true" /><small>{draft.guardEnabled ? "Enabled" : "Disabled"}</small></label>
        </div>
        {GUARD_RISK_CATEGORIES.map((category) => <label className="settings-policy-row" key={category}>
          <span><strong>{GUARD_RULE_LABELS[category]}</strong><small>{GUARD_RULE_DESCRIPTIONS[category]}</small></span>
          <select
            value={(draft.guardRules ?? DEFAULT_GUARD_RULES)[category]}
            disabled={controlsDisabled || !draft.guardEnabled}
            onChange={(event) => void save({
              ...draft,
              guardRules: { ...(draft.guardRules ?? DEFAULT_GUARD_RULES), [category]: event.target.value as typeof GUARD_ACTIONS[number] },
            })}
          >
            {GUARD_ACTIONS.map((action) => <option value={action} key={action}>{action === "allow" ? "Allow" : action === "confirm" ? "Confirm" : "Block"}</option>)}
          </select>
        </label>)}
        <RuntimePolicyTimeoutControl
          label="Guard timeout"
          description="How long a confirmation request stays open."
          value={draft.guardTimeoutSeconds}
          disabled={controlsDisabled}
          onChange={(guardTimeoutSeconds) => void save({ ...draft, guardTimeoutSeconds })}
        />
        <RuntimePolicyTimeoutControl
          label="Clarify timeout"
          description="How long Pylon waits for a clarification answer."
          value={draft.clarifyTimeoutSeconds}
          disabled={controlsDisabled}
          onChange={(clarifyTimeoutSeconds) => void save({ ...draft, clarifyTimeoutSeconds })}
        />
      </div>
    </section>

    <section className="settings-policy-group" aria-labelledby="global-policy-workspace-title">
      <header><h3 id="global-policy-workspace-title">Workspace defaults</h3><p>Choose where sessions begin work when no closer override exists.</p></header>
      <div className="settings-policy-list">
        <label className="settings-policy-row">
          <span><strong>Workspace</strong><small>Local does not create a branch or worktree.</small></span>
          <select value={draft.workspace} disabled={controlsDisabled} onChange={(event) => void save({ ...draft, workspace: event.target.value as RuntimePolicyReadModel["global"]["workspace"] })}>
            <option value="local">Local</option>
            <option value="checkout">Project folder</option>
            <option value="worktree">Session worktree</option>
          </select>
        </label>
      </div>
    </section>

    <p className="settings-policy-note"><strong>Project and session overrides are not reset.</strong> Only inherited fields follow a new global default.</p>
    {disabled && <p className="settings-policy-note">Global policy can change when every active session is idle.</p>}
    {error && <p className="settings-policy-error" role="alert">{error}</p>}
    {busy && <p className="settings-policy-saving" role="status">Saving…</p>}
  </>;
}

function hasPackageFields(settings: PackageSettingsReadModel | undefined): boolean {
  return Boolean(settings && settings.kind !== "timeline");
}

function PackageFields({ settings, models, sessionThinkingLevels, disabled, onUpdate }: {
  settings: PackageSettingsReadModel;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  disabled: boolean;
  onUpdate: (settings: PackageSettingsReadModel) => void;
}) {
  if (settings.kind === "advisor" || settings.kind === "scout") {
    const levels = thinkingLevels(settings.mode === "model" ? settings.model : undefined, models, sessionThinkingLevels);
    return <div className="package-fields">
      <ModelModeField value={settings.mode === "model" ? settings.model! : settings.mode} models={models} disabled={disabled} onChange={(value) => {
        const mode = value === "disabled" || value === "session" ? value : "model";
        onUpdate({ ...settings, mode, ...(mode === "model" ? { model: value } : { model: undefined }) });
      }} />
      <ThinkingField value={settings.thinking} levels={levels} disabled={disabled || settings.mode === "disabled"} onChange={(thinking) => onUpdate({ ...settings, thinking })} />
    </div>;
  }
  if (settings.kind === "grunt") {
    return <div className="package-fields">
      <ModelModeField value={settings.mode === "model" ? settings.model! : settings.mode} models={models} disabled={disabled} onChange={(value) => {
        const mode = value === "disabled" || value === "session" ? value : "model";
        onUpdate({ ...settings, mode, ...(mode === "model" ? { model: value } : { model: undefined }) });
      }} />
      <label>Execution mode<select value={settings.executionMode} disabled={disabled} onChange={(event) => onUpdate({ ...settings, executionMode: event.target.value as typeof settings.executionMode })}>
        <option value="isolated">Isolated</option><option value="direct">Direct</option><option value="dynamic">Dynamic</option>
      </select></label>
      <ThinkingChoices label="Eligible thinking levels" value={settings.thinkingLevels} disabled={disabled} onChange={(thinkingLevels) => onUpdate({ ...settings, thinkingLevels })} />
    </div>;
  }
  if (settings.kind === "continuity") {
    return <div className="package-fields continuity-fields">
      <label className="checkbox-field"><input type="checkbox" checked={settings.memoryEnabled} disabled={disabled} onChange={(event) => onUpdate({ ...settings, memoryEnabled: event.target.checked })} />Durable memory</label>
      <label>Continuity retained tokens<input key={settings.keepRecentTokens} type="number" min={1_000} max={50_000} step={1_000} defaultValue={settings.keepRecentTokens} disabled={disabled} onBlur={(event) => {
        const keepRecentTokens = Number(event.target.value);
        if (Number.isSafeInteger(keepRecentTokens) && keepRecentTokens >= 1_000 && keepRecentTokens <= 50_000) {
          if (keepRecentTokens !== settings.keepRecentTokens) onUpdate({ ...settings, keepRecentTokens });
        } else event.currentTarget.value = String(settings.keepRecentTokens);
      }} /></label>
      <p className="settings-policy-note">Recent raw history kept by Continuity compaction. This overrides Pi&apos;s retained-token value only for Continuity-owned compactions.</p>
      <ProfileFields label="Planner" profile={settings.planner} models={models} disabled={disabled} onChange={(planner) => onUpdate({ ...settings, planner })} />
      <ProfileFields label="Executor" profile={settings.executor} models={models} disabled={disabled} onChange={(executor) => onUpdate({ ...settings, executor })} />
      <ProfileFields label="Memory reviewer" profile={settings.memoryReviewer} models={models} disabled={disabled} onChange={(memoryReviewer) => onUpdate({ ...settings, memoryReviewer })} />
      <ProfileFields label="Compaction reviewer" profile={settings.compactionReviewer} models={models} disabled={disabled} onChange={(compactionReviewer) => onUpdate({ ...settings, compactionReviewer })} />
    </div>;
  }
  if (settings.kind === "sieve") {
    return <div className="package-fields">
      <label className="checkbox-field"><input type="checkbox" checked={settings.activePruning} disabled={disabled} onChange={(event) => onUpdate({ ...settings, activePruning: event.target.checked })} />Active pruning</label>
      <label>Projection mode<select value={settings.projectionMode} disabled={disabled} onChange={(event) => onUpdate({ ...settings, projectionMode: event.target.value as typeof settings.projectionMode })}>
        <option value="standard-v2">Standard (default)</option><option value="legacy">Standard V1 (legacy)</option><option value="stable">Stable (experimental)</option>
      </select></label>
      <label>Pruning threshold<input key={settings.threshold} type="number" min={1_000} max={50_000} step={1_000} defaultValue={settings.threshold} disabled={disabled} onBlur={(event) => {
        const threshold = Number(event.target.value);
        if (Number.isSafeInteger(threshold) && threshold >= 1_000 && threshold <= 50_000 && threshold !== settings.threshold) {
          onUpdate({ ...settings, threshold });
        }
      }} /></label>
      {settings.projectionMode === "stable" && <>
        <label>Rollover high multiplier<input key={settings.rolloverHighMultiplier} type="number" min={2} max={64} step={1} defaultValue={settings.rolloverHighMultiplier} disabled={disabled} onBlur={(event) => {
          const high = Number(event.target.value);
          if (Number.isSafeInteger(high) && high > settings.rolloverLowMultiplier && high <= 64 && high !== settings.rolloverHighMultiplier) {
            onUpdate({ ...settings, rolloverHighMultiplier: high });
          }
        }} /></label>
        <label>Rollover target multiplier<input key={settings.rolloverLowMultiplier} type="number" min={1} max={63} step={1} defaultValue={settings.rolloverLowMultiplier} disabled={disabled} onBlur={(event) => {
          const low = Number(event.target.value);
          if (Number.isSafeInteger(low) && low >= 1 && low < settings.rolloverHighMultiplier && low !== settings.rolloverLowMultiplier) {
            onUpdate({ ...settings, rolloverLowMultiplier: low });
          }
        }} /></label>
      </>}
    </div>;
  }
  if (settings.kind === "spawn") {
    return <div className="package-fields">
      <ModelChoices value={settings.models} models={models} disabled={disabled} onChange={(eligible) => onUpdate({ ...settings, models: eligible })} />
      <ThinkingChoices label="Private-agent thinking" value={settings.agentThinkingLevels} disabled={disabled} onChange={(agentThinkingLevels) => onUpdate({ ...settings, agentThinkingLevels })} />
    </div>;
  }
  if (settings.kind === "timeline") return null;
  if (settings.kind !== "helios") return null;
  return <div className="package-fields">
    <label>Future owned browsers<select value={settings.headed ? "shown" : "headless"} disabled={disabled} onChange={(event) => onUpdate({ ...settings, headed: event.target.value === "shown" })}>
      <option value="shown">Shown</option><option value="headless">Headless</option>
    </select></label>
  </div>;
}

function ThinkingChoices({ label, value, disabled, onChange }: {
  label: string;
  value: ThinkingLevelReadModel[];
  disabled: boolean;
  onChange: (value: ThinkingLevelReadModel[]) => void;
}) {
  return <fieldset><legend>{label}</legend>{PACKAGE_THINKING_LEVELS.map((level) => <label className="checkbox-field" key={level}>
    <input type="checkbox" checked={value.includes(level)} disabled={disabled || value.length === 1 && value[0] === level} onChange={(event) => onChange(event.target.checked ? [...value, level] : value.filter((item) => item !== level))} />{thinkingLabel(level)}
  </label>)}</fieldset>;
}

function ModelChoices({ value, models, disabled, onChange }: {
  value?: string[];
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value?: string[]) => void;
}) {
  const available = models.map((model) => ({ ref: `${model.provider}/${model.id}`, name: model.name }));
  const choices = [...available, ...(value ?? []).filter((ref) => !available.some((model) => model.ref === ref)).map((ref) => ({ ref, name: ref }))];
  return <fieldset><legend>Eligible models</legend>
    <label className="checkbox-field"><input type="checkbox" checked={value === undefined} disabled={disabled || !available.length} onChange={(event) => onChange(event.target.checked ? undefined : available.map((model) => model.ref))} />All available models</label>
    {choices.map((model) => <label className="checkbox-field" key={model.ref}><input type="checkbox" checked={value?.includes(model.ref) ?? false} disabled={disabled || value === undefined || value.length === 1 && value[0] === model.ref} onChange={(event) => onChange(event.target.checked ? [...(value ?? []), model.ref] : value?.filter((item) => item !== model.ref))} />{model.name}</label>)}
  </fieldset>;
}

function ModelModeField({ value, models, disabled, onChange }: { value: string; models: ModelOptionReadModel[]; disabled: boolean; onChange: (value: string) => void }) {
  return <label>Model<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="disabled">Disabled</option>
    <option value="session">Use session model</option>
    {models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name}</option>)}
  </select></label>;
}

function ProfileFields({ label, profile, models, disabled, onChange }: {
  label: string;
  profile?: { model: string; thinking?: ThinkingLevelReadModel };
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (profile: { model: string; thinking?: ThinkingLevelReadModel } | undefined) => void;
}) {
  const levels = thinkingLevels(profile?.model, models, []);
  return <fieldset><legend>{label}</legend>
    <label>Model<select value={profile?.model ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value ? { model: event.target.value } : undefined)}>
      <option value="">Not configured</option>
      {models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name}</option>)}
    </select></label>
    <ThinkingField value={profile?.thinking} levels={levels} disabled={disabled || !profile} onChange={(thinking) => profile && onChange({ ...profile, thinking })} />
  </fieldset>;
}

function ThinkingField({ value, levels, disabled, onChange }: { value?: ThinkingLevelReadModel; levels: ThinkingLevelReadModel[]; disabled: boolean; onChange: (value?: ThinkingLevelReadModel) => void }) {
  return <label>Thinking<select value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value ? event.target.value as ThinkingLevelReadModel : undefined)}>
    <option value="">Inherit session thinking</option>
    {levels.map((level) => <option value={level} key={level}>{thinkingLabel(level)}</option>)}
  </select></label>;
}

function thinkingLevels(modelRef: string | undefined, models: ModelOptionReadModel[], fallback: ThinkingLevelReadModel[]): ThinkingLevelReadModel[] {
  return modelRef
    ? models.find((model) => `${model.provider}/${model.id}` === modelRef)?.thinkingLevels ?? []
    : fallback;
}
