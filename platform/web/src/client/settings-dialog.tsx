import { IconSettings, IconStack2, IconX } from "@tabler/icons-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ThinkingLevelReadModel } from "../shared/protocol/events";
import type { ModelOptionReadModel } from "../shared/protocol/events";
import type { PackageSettingsReadModel, PackageSummary } from "../shared/protocol/snapshots";
import { thinkingLabel } from "./format";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";

interface SettingsDialogProps {
  packages: PackageSummary[];
  loading: boolean;
  busy: string;
  disabled: boolean;
  models: ModelOptionReadModel[];
  sessionThinkingLevels: ThinkingLevelReadModel[];
  onClose: () => void;
  onSetEnabled: (item: PackageSummary, enabled: boolean) => void;
  onUpdate: (item: PackageSummary, settings: PackageSettingsReadModel) => void;
}

export function SettingsDialog({ packages, loading, busy, disabled, models, sessionThinkingLevels, onClose, onSetEnabled, onUpdate }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
    if (!focusable?.length) return;
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

  return <div className="settings-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onKeyDown={onKeyDown}>
      <header>
        <div><IconSettings size={18} /><strong id="settings-dialog-title">Settings</strong></div>
        <button data-autofocus className="icon-button" type="button" onClick={onClose} aria-label="Close settings"><IconX size={17} /></button>
      </header>
      <div className="settings-content">
        <p className="settings-intro">Package settings apply globally and reload the selected session.</p>
        <section className="settings-sounds" aria-labelledby="settings-sounds-title">
          <div>
            <strong id="settings-sounds-title">Notification sounds</strong>
            <small>Preview cues played when a turn completes or needs your attention.</small>
          </div>
          <div className="settings-sound-actions">
            <button type="button" onClick={() => playSound("turn-complete")}>Play turn complete</button>
            <button type="button" onClick={() => playSound("attention")}>Play attention</button>
          </div>
        </section>
        {loading && packages.length === 0 && <div className="settings-empty">Detecting packages…</div>}
        {!loading && packages.length === 0 && <div className="settings-empty"><IconStack2 size={22} /><strong>No local Pi packages</strong></div>}
        {packages.map((item) => {
          const itemDisabled = disabled || Boolean(busy);
          const state = item.error ? "failed" : item.active ? "active" : item.enabled ? "unavailable" : "disabled";
          return <section className="settings-package" key={item.id}>
            <header>
              <div>
                <strong>{item.name}</strong>
                <small>{item.description || `${item.extensionCount} Pi extension${item.extensionCount === 1 ? "" : "s"}`}</small>
                {item.error && <span className="package-error">{item.error}</span>}
              </div>
              <span className={`package-state is-${state}`}>{state}</span>
              {item.required
                ? <span className="package-required">Required</span>
                : <label className="package-switch">
                    <span className="sr-only">{item.enabled ? "Disable" : "Enable"} {item.name}</span>
                    <input type="checkbox" role="switch" checked={item.enabled} disabled={itemDisabled} onChange={(event) => onSetEnabled(item, event.target.checked)} />
                  </label>}
            </header>
            {item.settings && <PackageFields
              settings={item.settings}
              models={models}
              sessionThinkingLevels={sessionThinkingLevels}
              disabled={itemDisabled}
              onUpdate={(settings) => onUpdate(item, settings)}
            />}
          </section>;
        })}
        {disabled && !loading && <p className="settings-note" role="status">Settings are available when every active session is idle.</p>}
      </div>
    </div>
  </div>;
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
