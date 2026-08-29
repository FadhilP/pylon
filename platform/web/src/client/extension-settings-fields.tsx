import { IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { ExtensionListSnapshot, NativeExtensionReadModel } from "../shared/protocol/snapshots";

export function ExtensionSettingsFields({
  snapshot,
  loading,
  disabled,
  onToggle,
  onInstall,
  onRemove,
  onTrust,
  onReload,
}: {
  snapshot?: ExtensionListSnapshot;
  loading: boolean;
  disabled: boolean;
  onToggle: (extension: NativeExtensionReadModel, enabled: boolean) => Promise<void>;
  onInstall: (source: string, scope: "user" | "project") => Promise<void>;
  onRemove: (source: string, scope: "user" | "project") => Promise<void>;
  onTrust: (trusted: boolean) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
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
      await onInstall(value, scope);
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
      <p className="settings-note">
        <strong>Security:</strong> Extensions execute arbitrary server-side code. Global resources live in Pylon’s agent
        directory, not the separate Pi CLI directory.
      </p>

      {snapshot.projectTrustRequired && (
        <section className="workbench-section">
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

      <section className="workbench-section">
        <header>
          <div>
            <h4>Install Pi package</h4>
            <p>Supports npm: and Pi-compatible git sources.</p>
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
            aria-label="Install scope"
            value={scope}
            disabled={disabled}
            onChange={event => setScope(event.target.value as "user" | "project")}>
            <option value="user">Global to Pylon</option>
            <option value="project" disabled={!snapshot.projectTrusted}>
              This project
            </option>
          </select>
          <button type="submit" disabled={disabled || !source.trim()}>
            <IconPlus size={14} /> Install
          </button>
        </form>
        {snapshot.packages.length > 0 && (
          <div className="settings-option-list">
            {snapshot.packages.map(item => (
              <div key={`${item.scope}:${item.source}`}>
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
                <div key={extension.id}>
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

      <div className="extension-reload">
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
