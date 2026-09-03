import { IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { ExtensionListSnapshot, NativeExtensionReadModel } from "../shared/protocol/snapshots";
import { OverviewOrb } from "./overview-primitives";
import { settingSearchTarget } from "../shared/settings-search";

export function ExtensionSettingsFields({
  snapshot,
  projects,
  loading,
  disabled,
  onToggle,
  onInstall,
  onRemove,
  onTrust,
  onReload,
}: {
  snapshot?: ExtensionListSnapshot;
  projects: { id: string; label: string }[];
  loading: boolean;
  disabled: boolean;
  onToggle: (extension: NativeExtensionReadModel, enabled: boolean) => Promise<void>;
  onInstall: (source: string, scope: "user" | "project", projectId?: string) => Promise<void>;
  onRemove: (source: string, scope: "user" | "project") => Promise<void>;
  onTrust: (trusted: boolean) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("user");
  const [error, setError] = useState("");

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extension operation failed");
    }
  };
  const install = (event: FormEvent) => {
    event.preventDefault();
    const value = source.trim();
    if (!value) return;
    if (!window.confirm(`Install ${value}? Pi extensions execute arbitrary code with Pylon server permissions.`))
      return;
    void run(async () => {
      const projectId = target.startsWith("project:") ? target.slice("project:".length) : undefined;
      await onInstall(value, projectId ? "project" : "user", projectId);
      setSource("");
    });
  };
  if (loading && !snapshot) return <div className="settings-empty">Discovering Pi extensions…</div>;
  if (!snapshot)
    return (
      <div className="settings-empty">
        <strong>Extension inventory unavailable</strong>
      </div>
    );

  const groups = (["user", "project"] as const).map(group => ({
    scope: group,
    extensions: snapshot.extensions.filter(extension => extension.scope === group),
  }));

  return (
    <div className="extension-settings">
      <p className="settings-callout">
        <OverviewOrb state="attention" label="Security notice" />
        <span>
          <strong>Extensions execute arbitrary server-side code.</strong>
          Global resources live in Pylon’s agent directory, not the separate Pi CLI directory.
        </span>
      </p>

      {snapshot.projectTrustRequired && (
        <section className="workbench-section" data-settings-search-target="project-extensions">
          <header>
            <div>
              <h4>Project extensions</h4>
              <p>
                {snapshot.projectTrusted
                  ? "This project may load .pi extensions and settings."
                  : "Project .pi resources are blocked until you trust this folder."}
              </p>
            </div>
            <button type="button" disabled={disabled} onClick={() => void run(() => onTrust(!snapshot.projectTrusted))}>
              {snapshot.projectTrusted ? "Revoke trust" : "Trust project"}
            </button>
          </header>
        </section>
      )}

      <section className="workbench-section" data-settings-search-target="install-pi-package">
        <header>
          <div>
            <h4>Install Pi package</h4>
            <p>Choose whether to install globally or into one registered project.</p>
          </div>
        </header>
        <form className="extension-install" onSubmit={install}>
          <input
            aria-label="Pi package source"
            value={source}
            disabled={disabled}
            onChange={event => setSource(event.target.value)}
            placeholder="npm:@scope/package@1.0.0"
          />
          <select
            aria-label="Install target"
            value={target}
            disabled={disabled}
            onChange={event => setTarget(event.target.value)}>
            <option value="user">Global to Pylon</option>
            {projects.map(project => (
              <option key={project.id} value={`project:${project.id}`}>
                {project.label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={disabled || !source.trim()}>
            <IconPlus size={14} /> Install
          </button>
        </form>
        {snapshot.packages.length > 0 && (
          <div className="settings-option-list">
            {snapshot.packages.map(item => (
              <div
                data-settings-search-target={`extension-package-${settingSearchTarget(`${item.scope}-${item.source}`)}`}
                key={`${item.scope}:${item.source}`}>
                <span>
                  <strong>{item.source}</strong>
                  <small>{item.scope === "user" ? "Global to Pylon" : "Project package"}</small>
                </span>
                <button
                  type="button"
                  disabled={disabled || (item.scope === "project" && !snapshot.projectTrusted)}
                  onClick={() => {
                    if (!window.confirm(`Remove ${item.source} from ${item.scope} Pi settings?`)) return;
                    void run(() => onRemove(item.source, item.scope));
                  }}>
                  <IconTrash size={14} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {groups.map(group => (
        <section className="workbench-section" key={group.scope}>
          <header>
            <div>
              <h4>{group.scope === "user" ? "Global extensions" : "Project extensions"}</h4>
              <p>
                {group.scope === "user"
                  ? "Resolved from Pylon’s agent directory and global Pi settings."
                  : "Resolved from this project’s trusted .pi directory and settings."}
              </p>
            </div>
            <span>{group.extensions.length}</span>
          </header>
          {group.extensions.length === 0 ? (
            <p className="workbench-empty">No {group.scope} extensions discovered.</p>
          ) : (
            <div className="settings-option-list">
              {group.extensions.map(extension => (
                <div
                  data-settings-search-target={`extension-${settingSearchTarget(extension.id)}`}
                  key={extension.id}>
                  <span>
                    <strong>{extension.path}</strong>
                    <small>
                      {extension.source} ·{" "}
                      {extension.active ? "loaded" : extension.enabled ? "reload required" : "disabled"}
                    </small>
                    {extension.loadError && <small className="package-error">{extension.loadError}</small>}
                  </span>
                  <label className="package-switch">
                    <span className="sr-only">Enable {extension.path}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={extension.enabled}
                      disabled={disabled || (group.scope === "project" && !snapshot.projectTrusted)}
                      onChange={event => {
                        const enabled = event.target.checked;
                        if (
                          enabled &&
                          !window.confirm(
                            `Enable ${extension.path}? Pi extensions execute arbitrary code with Pylon server permissions.`,
                          )
                        )
                          return;
                        void run(() => onToggle(extension, enabled));
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}

      <div className="extension-reload" data-settings-search-target="reload-extensions">
        <button type="button" disabled={disabled} onClick={() => void run(onReload)}>
          <IconRefresh size={14} /> Reload extensions
        </button>
        <span>Apply changed extension settings to active sessions.</span>
      </div>
      {error && (
        <p className="hook-settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
