import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, LoadedMcpConfig, McpServerEntry, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { withDirectoryLock } from "pylon-core/file-lock";
import { mutateWorkspace, readWorkspaceEntry } from "../workspace/workspace-mutations.ts";
import { validMcpSettingsAction, type McpSettingsAction, type McpSettingsSnapshot, type McpState } from "../../shared/settings/mcp.ts";

type Snapshot = Omit<McpSettingsSnapshot, "sessionGeneration">;
export interface McpConfigAccess {
  loadMcpConfig(options: {agentDir: string; cwd: string; projectTrusted: boolean}): LoadedMcpConfig;
  updateMcpServerConfig(path: string, name: string, patch: {enabled?: boolean; exposure?: string}, options?: {override?: boolean}): void;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Compatibility adapter for Pi 1.0.4's plain /mcp status; raw output never crosses the Web boundary. */
export function nativeMcpStates(text: string, names: string[]): Map<string, {state: McpState; toolCount?: number}> {
  const result = new Map<string, {state: McpState; toolCount?: number}>();
  for (const name of names) {
    const records = text.split("\n").filter(line => line.startsWith(`${name}: `));
    if (records.length !== 1) continue;
    const value = records[0]!.slice(name.length + 2);
    const match = /^(starting|connecting|connected|disabled|needs sign-in, run \/mcp login [A-Za-z0-9_-]+|disconnected, reconnects on next call|failed)(?:, (\d+) tools)? \((?:codemode|deferred|direct|hidden)\)$/.exec(value);
    if (!match) continue;
    const state = match[1]!.startsWith("needs sign-in") ? "needs-auth" : match[1]!.startsWith("disconnected") ? "disconnected" : match[1] as McpState;
    result.set(name, {state, ...(match[2] ? {toolCount: Math.min(100_000, Number(match[2]))} : {})});
  }
  return result;
}

export class McpSettingsManager {
  private context?: ExtensionContext;
  private initialConfig = "";
  private states = new Map<string, {state: McpState; toolCount?: number}>();
  private probe?: Promise<void>;
  private stopped = false;
  private command?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  constructor(private agentDir: string, private config: McpConfigAccess, private registered: () => RegisteredMcpServer[]) {}
  bind(ctx: ExtensionContext, loaded: LoadedMcpConfig): void {
    this.context = ctx;
    this.initialConfig = hash(JSON.stringify(loaded));
  }
  setCommand(handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>): void { this.command = handler; }
  stop(): void { this.stopped = true; this.context = undefined; this.states.clear(); }
  private ctx(): ExtensionContext {
    if (!this.context || this.stopped) throw new Error("Native MCP management is unavailable");
    return this.context;
  }
  private load(): LoadedMcpConfig {
    const ctx = this.ctx();
    return this.config.loadMcpConfig({agentDir: this.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted()});
  }
  private entries(loaded: LoadedMcpConfig): McpServerEntry[] {
    const names = new Set(loaded.servers.map(entry => entry.name.replaceAll("-", "_")));
    return [...loaded.servers, ...this.registered().filter(entry => !names.has(entry.name.replaceAll("-", "_"))).map(entry => ({name:entry.name, config:entry.config, source:entry.extensionPath, scope:"extension" as const}))];
  }
  private async files(): Promise<Map<string, {version: string; text?: string}>> {
    const ctx = this.ctx();
    const paths = [join(this.agentDir, "mcp.json"), ...(ctx.isProjectTrusted() ? [join(ctx.cwd, ".pi", "mcp.json")] : [])];
    const files = new Map<string, {version: string; text?: string}>();
    for (const path of paths) {
      try {
        const root = await lstat(dirname(path));
        if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Unsafe configuration directory");
        const entry = await readWorkspaceEntry(dirname(path), "mcp.json", undefined, false);
        files.set(path, {version:entry.version, text:entry.text});
      } catch (error) {
        files.set(path, {version:(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable"});
      }
    }
    return files;
  }
  private async revision(): Promise<string> { return hash(JSON.stringify([...await this.files()].map(([path, entry]) => [path,entry.version]))); }
  private commandContext(notify: (text: string, type?: string) => void): ExtensionCommandContext {
    const ctx = this.ctx();
    return Object.create(ctx, { mode:{value:"rpc"}, ui:{value:Object.create(ctx.ui,{notify:{value:notify}})} });
  }
  private refreshStates(names: string[]): void {
    if (this.probe || !this.command) return;
    // The native command waits for startup. Do not let a stalled server hold Settings GET open.
    this.probe = this.command("", this.commandContext(text => {
      if (!this.stopped) this.states = nativeMcpStates(text, names);
    })).catch(() => { if (!this.stopped) this.states.clear(); }).finally(() => { this.probe = undefined; });
  }
  async snapshot(): Promise<Snapshot> {
    const loaded = this.load();
    const entries = this.entries(loaded);
    this.refreshStates(entries.map(entry => entry.name));
    const files = await this.files();
    const needsReload = this.initialConfig !== hash(JSON.stringify(loaded));
    return {
      sessionId:this.ctx().sessionManager.getSessionId(), available:true,
      userConfigPath:join(this.agentDir, "mcp.json"),
      revision:hash(JSON.stringify([...files].map(([path,entry])=>[path,entry.version]))),
      needsReload, configurationError:loaded.errors.length > 0,
      servers:entries.map(entry => ({
        name:entry.name, scope:entry.scope ?? "global", projectOverride:Boolean(entry.override),
        transport:"command" in entry.config ? "stdio" : "http",
        enabled:entry.config.enabled !== false, exposure:entry.config.exposure ?? "codemode",
        ...(needsReload ? {state:"unknown" as const} : this.states.get(entry.name) ?? {state:"unknown" as const}),
        writable:entry.scope !== "extension" && loaded.errors.length === 0 && files.get(entry.override ?? entry.source)?.text !== undefined,
      })),
    };
  }
  async action(input: McpSettingsAction): Promise<void> {
    if (!validMcpSettingsAction(input) || input.sessionId !== this.ctx().sessionManager.getSessionId()) throw new Error("Invalid MCP action");
    await withDirectoryLock(join(this.agentDir, "mcp-settings"), async () => {
      if (input.expectedRevision !== await this.revision()) throw new Error("MCP configuration changed. Refresh before retrying.");
      if (input.action === "reload") return;
      const loaded = this.load();
      if (this.initialConfig !== hash(JSON.stringify(loaded))) throw new Error("Reload MCP configuration before changing it");
      const entry = this.entries(loaded).find(entry => entry.name === input.name);
      if (!entry) throw new Error("MCP server is unavailable");
      if (input.action === "reconnect") {
        if (!this.command || entry.config.enabled === false) throw new Error("MCP server is disabled");
        let failed = false;
        await this.command(`reconnect ${input.name}`, this.commandContext((_text, type) => { if (type === "error" || type === "warning") failed = true; }));
        this.states.delete(input.name);
        if (failed) throw new Error("MCP reconnect failed. Inspect the server logs locally.");
        return;
      }
      const destination = entry.override ?? entry.source;
      const files = await this.files();
      const file = files.get(destination);
      if (entry.scope === "extension" || loaded.errors.length || file?.text === undefined) throw new Error("This MCP configuration cannot be edited safely. Edit it locally and reload.");
      const temporary = await mkdtemp(join(tmpdir(), "pylon-mcp-config-"));
      try {
        const stage = join(temporary, "mcp.json");
        await writeFile(stage, file.text, {flag:"wx",mode:0o600});
        this.config.updateMcpServerConfig(stage, input.name, input.action === "enabled" ? {enabled:input.enabled} : {exposure:input.exposure}, {override:Boolean(entry.override)});
        const text = await readFile(stage, "utf8");
        if (input.expectedRevision !== await this.revision()) throw new Error("MCP configuration changed. Refresh before retrying.");
        // Reuse optimistic identity/content checks and Windows ACL/Linux metadata-preserving replacement.
        await mutateWorkspace(dirname(destination), {action:"save",path:"mcp.json",expectedVersion:file.version,text});
      } catch (error) {
        if (error instanceof Error && error.message === "MCP configuration changed. Refresh before retrying.") throw error;
        throw new Error("MCP settings could not be safely saved or confirmed. Inspect configuration locally and reload before retrying.");
      } finally { await rm(temporary,{recursive:true,force:true}); }
    }, {name:"MCP settings"});
  }
}

export interface McpManagement { snapshot(): Promise<Snapshot>; action(input: McpSettingsAction): Promise<void> }
