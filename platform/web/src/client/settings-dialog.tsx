import { IconChevronRight, IconExternalLink, IconKey, IconLogout, IconSettings, IconStack2, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ModelOptionReadModel, ProviderAuthReadModel, ProviderAuthType, ThinkingLevelReadModel, UiRequestReadModel } from "../shared/protocol/events";
import type { PackageSettingsReadModel, PackageSummary } from "../shared/protocol/snapshots";
import { thinkingLabel } from "./format";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";
import { UiDialog } from "./ui-dialog";

export type SettingsTab = "providers" | "packages" | "notifications" | "appearance";
type SettingsTheme = "light" | "dark";
const SETTINGS_TABS: SettingsTab[] = ["providers", "packages", "notifications", "appearance"];

interface SettingsDialogProps {
  initialTab?: SettingsTab;
  initialProviderQuery?: string;
  providerAuth?: ProviderAuthReadModel;
  pendingUi?: UiRequestReadModel;
  packages: PackageSummary[];
  loading: boolean;
  busy: string;
  disabled: boolean;
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
}

export function SettingsDialog({ initialTab = "packages", initialProviderQuery = "", providerAuth, pendingUi, packages, loading, busy, disabled, models, sessionThinkingLevels, theme, onThemeChange, onClose, onProviderLogin, onProviderLogout, onProviderCancel, onSetEnabled, onUpdate }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [providerQuery, setProviderQuery] = useState(initialProviderQuery);
  const [packageQuery, setPackageQuery] = useState("");
  const [expandedPackage, setExpandedPackage] = useState<string | null | undefined>();
  const filteredPackages = packages.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(packageQuery.trim().toLowerCase()));
  const providers = providerAuth?.providers ?? [];
  const filteredProviders = providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase()));
  const authFlow = providerAuth?.flow;
  const authRunning = authFlow?.status === "running";

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
    const focusable = [...dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])") ?? []]
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

  const firstConfigurablePackage = filteredPackages.find((item) => hasPackageFields(item.settings))?.id;

  return <div className="settings-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onKeyDown={onKeyDown}>
      <header>
        <div><IconSettings size={18} /><strong id="settings-dialog-title">Settings</strong><span>Changes apply across this workspace</span></div>
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
          <p>Settings save immediately.<br />Press Esc to close.</p>
        </nav>

        <div className="settings-content">
          <section id="settings-panel-providers" className="settings-pane" role="tabpanel" aria-labelledby="settings-tab-providers" hidden={activeTab !== "providers"}>
            <div className="settings-pane-header">
              <div><h2>Providers</h2><p>Connect accounts and API keys used by Pi. Credentials stay on this machine.</p></div>
              <input type="search" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="Filter providers" aria-label="Filter providers" />
            </div>
            {authFlow && <div className={`provider-auth-flow is-${authFlow.status}`} role="status">
              <div><strong>{authFlow.providerName}</strong><span>{authFlow.message ?? "Authentication in progress."}</span></div>
              {authFlow.authUrl && <a href={authFlow.authUrl} target="_blank" rel="noopener noreferrer">Open sign-in page <IconExternalLink size={14} /></a>}
              {authFlow.deviceCode && <div className="provider-device-code">
                <code>{authFlow.deviceCode.userCode}</code>
                <a href={authFlow.deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">Open verification page <IconExternalLink size={14} /></a>
              </div>}
              {authFlow.links?.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label ?? "Open provider page"} <IconExternalLink size={14} /></a>)}
              {authRunning && <button type="button" className="secondary-button" onClick={onProviderCancel}>Cancel</button>}
            </div>}
            {pendingUi?.payload.context === "provider-auth" && <div className="provider-auth-prompt"><UiDialog request={pendingUi} /></div>}
            {providers.length === 0 && <div className="settings-empty"><IconKey size={22} /><strong>No providers available</strong></div>}
            {providers.length > 0 && filteredProviders.length === 0 && <div className="settings-empty"><strong>No matching providers</strong><span>Try a different filter.</span></div>}
            {filteredProviders.length > 0 && <div className="settings-provider-list">{filteredProviders.map((provider) => <section className="settings-provider" key={provider.id}>
              <div className="settings-provider-copy">
                <span className="provider-mark" aria-hidden="true">{packageInitials(provider.name)}</span>
                <span><strong>{provider.name}</strong><small>{provider.id}</small></span>
              </div>
              <span className={`provider-state${provider.configured ? " is-connected" : ""}`}>{provider.configured ? provider.stored ? "Connected" : "External" : "Not connected"}</span>
              <div className="provider-actions">
                {!provider.configured && provider.methods.map((method) => <button
                  key={method.type}
                  type="button"
                  disabled={disabled || authRunning || !method.interactive}
                  title={method.interactive ? undefined : "Configured outside Pylon"}
                  onClick={() => onProviderLogin(provider.id, method.type)}
                >{method.type === "oauth" ? "Sign in" : "Add key"}</button>)}
                {provider.configured && provider.stored && <button className="provider-disconnect" type="button" disabled={disabled || authRunning} onClick={() => onProviderLogout(provider.id)}><IconLogout size={14} /> Disconnect</button>}
              </div>
            </section>)}</div>}
            {disabled && <p className="settings-note" role="status">Provider settings are available when every active session is idle.</p>}
          </section>

          <section id="settings-panel-packages" className="settings-pane" role="tabpanel" aria-labelledby="settings-tab-packages" hidden={activeTab !== "packages"}>
            <div className="settings-pane-header">
              <div><h2>Packages</h2><p>Enable local Pi packages and tune how each one runs. Expand a package to edit its defaults.</p></div>
              <input type="search" value={packageQuery} onChange={(event) => setPackageQuery(event.target.value)} placeholder="Filter packages" aria-label="Filter packages" />
            </div>
            {loading && packages.length === 0 && <div className="settings-empty">Detecting packages…</div>}
            {!loading && packages.length === 0 && <div className="settings-empty"><IconStack2 size={22} /><strong>No local Pi packages</strong></div>}
            {!loading && packages.length > 0 && filteredPackages.length === 0 && <div className="settings-empty"><strong>No matching packages</strong><span>Try a different filter.</span></div>}
            {packages.length > 0 && <div className="settings-package-list">{packages.map((item) => {
              const itemDisabled = disabled || Boolean(busy);
              const matchesFilter = filteredPackages.some((candidate) => candidate.id === item.id);
              const state = item.error ? "failed" : item.active ? "active" : item.enabled ? "unavailable" : "disabled";
              const configurable = hasPackageFields(item.settings);
              const expanded = configurable && (expandedPackage === item.id || (expandedPackage === undefined && item.id === firstConfigurablePackage));
              const detailsId = `package-settings-${item.id}`;
              return <section className={`settings-package${expanded ? " is-expanded" : ""}`} key={item.id} hidden={!matchesFilter}>
                <header>
                  <div className="settings-package-main">
                    <span className="package-mark" aria-hidden="true">{packageInitials(item.name)}</span>
                    <span className="package-copy">
                      <strong>{item.name}</strong>
                      <small>{item.description || `${item.extensionCount} Pi extension${item.extensionCount === 1 ? "" : "s"}`}</small>
                      {item.error && <span className="package-error">{item.error}</span>}
                    </span>
                  </div>
                  <span className={`package-state is-${state}`}>{state}</span>
                  {item.required
                    ? <span className="package-required">Required</span>
                    : <label className="package-switch">
                        <span className="sr-only">{item.enabled ? "Disable" : "Enable"} {item.name}</span>
                        <input type="checkbox" role="switch" checked={item.enabled} disabled={itemDisabled} onChange={(event) => onSetEnabled(item, event.target.checked)} />
                      </label>}
                  {configurable && <button className="package-expand" type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${item.name} settings`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedPackage(expanded ? null : item.id)}><IconChevronRight size={15} /></button>}
                </header>
                {configurable && item.settings && <div id={detailsId} hidden={!expanded}><PackageFields
                  settings={item.settings}
                  models={models}
                  sessionThinkingLevels={sessionThinkingLevels}
                  disabled={itemDisabled}
                  onUpdate={(settings) => onUpdate(item, settings)}
                /></div>}
              </section>;
            })}</div>}
            {disabled && !loading && <p className="settings-note" role="status">Settings are available when every active session is idle.</p>}
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

function hasPackageFields(settings: PackageSettingsReadModel | undefined): boolean {
  return Boolean(settings && settings.kind !== "timeline");
}

function packageInitials(name: string): string {
  const parts = name.replace(/^pi[-_]?/i, "").split(/[-_\s]+/);
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts.map((part) => part[0]).join("").slice(0, 2)).toUpperCase();
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
    </div>;
  }
  if (settings.kind === "continuity") {
    return <div className="package-fields continuity-fields">
      <ProfileFields label="Planner" profile={settings.planner} models={models} disabled={disabled} onChange={(planner) => onUpdate({ ...settings, planner })} />
      <ProfileFields label="Executor" profile={settings.executor} models={models} disabled={disabled} onChange={(executor) => onUpdate({ ...settings, executor })} />
    </div>;
  }
  if (settings.kind === "sieve") {
    return <div className="package-fields">
      <label className="checkbox-field"><input type="checkbox" checked={settings.activePruning} disabled={disabled} onChange={(event) => onUpdate({ ...settings, activePruning: event.target.checked })} />Active pruning</label>
      <label>Pruning threshold<input key={settings.threshold} type="number" min={1_000} max={50_000} step={1_000} defaultValue={settings.threshold} disabled={disabled} onBlur={(event) => {
        const threshold = Number(event.target.value);
        if (Number.isSafeInteger(threshold) && threshold >= 1_000 && threshold <= 50_000 && threshold !== settings.threshold) {
          onUpdate({ ...settings, threshold });
        }
      }} /></label>
    </div>;
  }
  if (settings.kind === "timeline") {
    return null;
  }
  if (settings.kind !== "helios") return null;
  return <div className="package-fields">
    <label>Future owned browsers<select value={settings.headed ? "shown" : "headless"} disabled={disabled} onChange={(event) => onUpdate({ ...settings, headed: event.target.value === "shown" })}>
      <option value="shown">Shown</option><option value="headless">Headless</option>
    </select></label>
  </div>;
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
