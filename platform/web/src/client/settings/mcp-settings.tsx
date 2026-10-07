import { useEffect, useRef, useState } from "react";
import { MCP_EXPOSURES, validMcpName, type McpSettingsInput, type McpSettingsSnapshot } from "../../shared/settings/mcp";
import { runtimeStore, useRuntimeStore } from "../runtime/event-store";
import { IconChevronRight, IconInfoCircle, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import "./mcp-settings.css";

const STATE_LABELS = {unknown:"Status unknown",starting:"Starting",connecting:"Connecting",connected:"Connected",disconnected:"Disconnected","needs-auth":"Sign-in required",failed:"Connection failed",disabled:"Disabled"};

export function McpSettingsPanel({onClose, onNavigate}: {onClose: () => void; onNavigate: (tab: "extensions" | "packages") => void}) {
  const {runtime, connection} = useRuntimeStore();
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const [loadError, setLoadError] = useState("");
  const operation = useRef({id:0,pending:false});
  useEffect(() => {
    const current = ++epoch.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    operation.current = {id:operation.current.id+1,pending:false};
    setSnapshot(undefined); setBusy(false); setError(""); setLoadError("");
    if (connection !== "connected" || !runtime?.ready) return;
    const load = async () => {
      if (operation.current.pending) {timer=setTimeout(() => void load(),3000); return;}
      const operationId = operation.current.id;
      try {
        const value = await runtimeStore.mcpSettings(controller.signal);
        if (epoch.current === current && operation.current.id === operationId) {setSnapshot(value); setLoadError("");}
      } catch (cause) {
        if (epoch.current === current && operation.current.id === operationId) setLoadError(cause instanceof Error ? cause.message : "Cannot load MCP settings");
      }
      if (epoch.current === current) timer = setTimeout(() => void load(), 3000);
    };
    void load();
    return () => {++epoch.current; controller.abort(); clearTimeout(timer);};
  }, [connection, runtime?.sessionId, runtime?.sessionGeneration, runtime?.ready]);
  const disabled = busy || connection !== "connected" || !snapshot?.available || !runtime?.ready;
  const act = async (input: McpSettingsInput, warning: string) => {
    if (disabled || operation.current.pending || !snapshot || !window.confirm(warning)) return;
    const current = epoch.current;
    operation.current.id++; operation.current.pending=true;
    setBusy(true); setError(""); setLoadError("");
    try {
      const result = await runtimeStore.mcpAction(input, snapshot);
      if (epoch.current === current) setSnapshot(result);
    } catch (cause) {
      if (epoch.current === current) {
        setError(cause instanceof Error ? cause.message : "MCP action failed. Refresh before retrying.");
        await runtimeStore.mcpSettings().then(value => {if (epoch.current === current) setSnapshot(value);}).catch(() => undefined);
      }
    } finally {if (epoch.current === current) {operation.current.pending=false; setBusy(false);}}
  };
  const auth = (name: string, action: "login" | "logout") => {
    if (disabled || operation.current.pending || !snapshot || !validMcpName(name) || snapshot.sessionId !== runtime?.sessionId || snapshot.sessionGeneration !== runtime.sessionGeneration) return;
    if (action === "logout" && !window.confirm(`Delete the saved OAuth credentials for ${name}?`)) return;
    // Use the established native command/dialog ownership path, not a second OAuth implementation.
    const pending = runtimeStore.sendMessage(`/mcp ${action} ${name}`);
    onClose();
    void pending.catch(cause => runtimeStore.reportError(cause instanceof Error ? cause.message : "MCP authentication failed"));
  };
  const servers = snapshot?.servers ?? [];
  const connected = servers.filter(server => server.enabled && server.state === "connected").length;
  const reload = () => act({action:"reload",confirmed:true}, "Reload MCP configuration in every live idle session? Enabled servers may start local processes or contact remote services.");
  return <div className="extension-settings mcp-settings" data-settings-search-target="mcp-servers">
    <div className="settings-pane-header">
      <div><h2>MCP servers</h2><p>Connect external tools and data to your session.</p></div>
      {snapshot?.available && (servers.length > 0 || snapshot.needsReload || snapshot.configurationError) &&
        <div className="extension-install mcp-actions"><button type="button" disabled={disabled} onClick={() => void reload()}><IconRefresh size={14} aria-hidden="true" />{busy ? "Applying…" : "Reload"}</button></div>}
    </div>
    {(error || loadError) && <p className="mcp-notice mcp-notice-error" role="alert">{error || loadError}</p>}
    {!snapshot && <div className="settings-empty mcp-empty" role="status">
      <IconPlugConnected size={28} aria-hidden="true" />
      <strong>{connection !== "connected" ? "Reconnect to manage servers" : !runtime?.ready ? "Select a ready session" : loadError ? "Couldn't load servers" : "Loading your servers…"}</strong>
      <p>{connection !== "connected" || !runtime?.ready ? "MCP connections belong to the selected session." : "Connection status refreshes automatically."}</p>
    </div>}
    {snapshot && !snapshot.available && <div className="settings-empty mcp-empty">
      <IconPlugConnected size={28} aria-hidden="true" />
      <strong>Native MCP is unavailable</strong><p>Check your extensions, or manage your alternate MCP adapter separately.</p>
      <div className="extension-install mcp-actions"><button type="button" onClick={() => onNavigate("extensions")}>Open Extensions</button></div>
    </div>}
    {snapshot?.configurationError && <p className="mcp-notice mcp-notice-error" role="alert">Configuration needs attention. Fix mcp.json locally, then reload.</p>}
    {snapshot?.needsReload && <p className="mcp-notice" role="status">Configuration changed on disk. Reload to apply it before changing servers.</p>}
    {snapshot?.available && !servers.length && <section className="mcp-empty mcp-onboarding">
      <div className="mcp-empty-icon"><IconPlugConnected size={28} aria-hidden="true" /></div>
      <h3>{snapshot.configurationError ? "Repair your server configuration" : "Connect your first MCP server"}</h3>
      <p>Add a server configuration to make its tools available in Pylon.</p>
      <details className="mcp-setup">
        <summary><IconChevronRight className="mcp-chevron" size={14} aria-hidden="true" />Set up a server</summary>
        <ol>
          <li><strong>Add your configuration locally</strong><p>Save your server’s <code>mcpServers</code> JSON to {snapshot.userConfigPath ? <code>{snapshot.userConfigPath}</code> : "your agent directory’s mcp.json"}, or <code>.pi/mcp.json</code> for a trusted project.</p><p>Only configure servers you trust: they can run commands with Pylon’s permissions.</p></li>
          <li><strong>Reload to connect</strong><p>Once saved, reload your idle sessions to pick up the server.</p><div className="extension-install mcp-actions"><button type="button" disabled={disabled} onClick={() => void reload()}><IconRefresh size={14} aria-hidden="true" />{busy ? "Applying…" : "Reload servers"}</button></div></li>
        </ol>
      </details>
    </section>}
    {snapshot?.available && servers.length > 0 && <>
      <div className="mcp-connection-summary" role="status"><span>{connected} of {servers.length} connected</span>
        {!connected && !snapshot.needsReload && !snapshot.configurationError && <p>{servers.every(server => !server.enabled) ? "Enable a server below to get started." : "Reconnect a server or sign in if needed. Status refreshes automatically."}</p>}
      </div>
      <div className="mcp-server-list">{servers.map(server => <section className="mcp-server-card" key={server.name}>
        <header><div><h3>{server.name}</h3><p>{server.transport === "stdio" ? "Local process" : "HTTP"} · {server.scope}{server.projectOverride ? " · project override" : ""}</p></div>
          <span className="mcp-status" role="status" data-state={snapshot.needsReload ? "unknown" : !server.enabled ? "disabled" : server.state}>{snapshot.needsReload ? "Reload required" : !server.enabled ? "Disabled" : STATE_LABELS[server.state]}{server.toolCount !== undefined && !snapshot.needsReload && server.enabled ? ` · ${server.toolCount} tools` : ""}</span>
        </header>
        <div className="mcp-server-controls">
          <label>Tool exposure <select aria-label={`Tool exposure for ${server.name}`} value={server.exposure} disabled={disabled || !server.writable || snapshot.needsReload}
            onChange={event => void act({action:"exposure",name:server.name,exposure:event.target.value as typeof MCP_EXPOSURES[number],confirmed:true}, `Change ${server.name} exposure to ${event.target.value}? Direct tools are declared to the model; hidden tools are unreachable. Individual tool overrides still apply.`)}>
            {MCP_EXPOSURES.map(exposure => <option key={exposure} value={exposure}>{exposure}</option>)}
          </select></label>
          <div className="extension-install mcp-actions">
            <button type="button" aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`} disabled={disabled || !server.writable || snapshot.needsReload}
              onClick={() => void act({action:"enabled",name:server.name,enabled:!server.enabled,confirmed:true}, `${server.enabled ? "Disable" : "Enable"} ${server.name}? Changes apply to live idle sessions. Enabling may execute its configured command and credential-resolution commands before tool approval.`)}>{server.enabled ? "Disable" : "Enable"}</button>
            <button type="button" aria-label={`Reconnect ${server.name}`} disabled={disabled || !server.enabled || snapshot.needsReload}
              onClick={() => void act({action:"reconnect",name:server.name,confirmed:true}, `Reconnect ${server.name}? This may restart a local server or contact a remote service.`)}>Reconnect</button>
            {server.transport === "http" && server.enabled && <>
              <button type="button" aria-label={`Sign in in chat (${server.name})`} disabled={disabled || snapshot.needsReload} onClick={() => auth(server.name,"login")}>Sign in in chat</button>
              <button type="button" aria-label={`Sign out in chat (${server.name})`} disabled={disabled || snapshot.needsReload} onClick={() => auth(server.name,"logout")}>Sign out in chat</button>
            </>}
          </div>
        </div>
        {!server.writable && <p className="mcp-readonly">{server.scope === "extension" ? "Managed by its extension." : "Configuration is read-only here. Edit the file locally."}</p>}
      </section>)}</div>
    </>}
    {snapshot?.available && <details className="mcp-help">
      <summary><IconInfoCircle size={14} aria-hidden="true" />Usage & security</summary>
      <ul>
        <li>For scripted calls, enable Web codemode in <button className="mcp-inline-link" type="button" onClick={() => onNavigate("packages")}>Packages → pylon-core</button>. For direct calls, use deferred or direct exposure. Individual tool overrides still apply.</li>
        <li>Guard confirmations still apply to tool calls. Server startup can execute configured commands before tool approval; MCP configuration is not a sandbox.</li>
        <li>Secrets and raw diagnostics stay out of this panel. Add/remove servers and advanced authentication settings in mcp.json locally. Sign-in/out uses Pi’s existing chat dialogs.</li>
      </ul>
    </details>}
  </div>;
}
