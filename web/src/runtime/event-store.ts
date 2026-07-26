import { useSyncExternalStore } from "react";
import type { WebCommand } from "../shared/protocol/commands";
import { PROTOCOL_VERSION, type WebEvent } from "../shared/protocol/envelope";
import type { ConnectionState, ConversationReadModel, MessageReadModel, OperationalReadModel, SessionControlsReadModel, SessionMetricsReadModel, ThinkingLevelReadModel, ToolActivityReadModel, UiRequestReadModel } from "../shared/protocol/events";
import type { SessionRuntimeState } from "../shared/protocol/events";
import type { PackageListSnapshot, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../shared/protocol/snapshots";
import type { PromptImage } from "../shared/protocol/commands";
import { isPackageListSnapshot, isSessionListSnapshot, isWebEvent } from "../shared/protocol/validation";
import { ApiClient } from "./api-client";

export interface RuntimeStoreSnapshot {
  connection: ConnectionState;
  runtime?: RuntimeSnapshot;
  pendingUi?: UiRequestReadModel;
  sequence: number;
  generation?: number;
  agentActive?: boolean;
  sessionStatuses?: Record<string, SessionRuntimeState>;
  error?: string;
}

const initial: RuntimeStoreSnapshot = { connection: "loading", sequence: 0 };
const eventNames = ["message.start", "message.update", "message.end", "tool.start", "tool.end", "queue.update", "retry.update", "compaction.update", "metrics.update", "ui.request", "ui.closed", "ui.ownership", "ui.notify", "ui.status", "ui.widget", "ui.title", "ui.editor-text", "agent.start", "agent.end", "session.status", "session.replaced", "session.unavailable", "stream.reset-required", "operational.pi-verify:lifecycle", "operational.pi-verify:result", "operational.pi-heartbeat:job", "operational.pi-guard:decision", "operational.pylon:tool-policy", "operational.pi-continuity:state-change", "operational.pi-timeline:state-change"];

function commandId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export class RuntimeEventStore {
  private readonly api = new ApiClient();
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private source?: EventSource;
  private frame?: number;
  private disposed = false;
  private started = false;
  private resetting = false;
  private bootstrapEpoch = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): RuntimeStoreSnapshot => this.snapshot;

  start(): void { if (this.started) return; this.started = true; void this.bootstrap(); }
  dispose(): void { this.disposed = true; this.source?.close(); if (this.frame !== undefined) cancelAnimationFrame(this.frame); }

  async sendMessage(message: string, images?: PromptImage[]): Promise<void> {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected" || !runtime.ready) throw new Error("Runtime is not connected");
    const type = runtime.conversation.streaming ? "followUp" : "prompt";
    await this.sendCommand({ type, message, ...(images?.length ? { images } : {}), commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async abort(): Promise<void> {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected") throw new Error("Runtime is not connected");
    await this.sendCommand({ type: "abort", commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async listSessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    const runtime = this.requireReadyRuntime();
    const sessions = await this.api.sessions(input);
    if (!isSessionListSnapshot(sessions) || sessions.sessionGeneration !== runtime.sessionGeneration) throw new Error("Session list is stale or invalid");
    return sessions;
  }

  async newSession(parentSessionId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "newSession",
      ...(parentSessionId ? { parentSessionId } : {}),
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    const runtime = this.requireReadyRuntime();
    const packages = await this.api.packages();
    if (!isPackageListSnapshot(packages) || packages.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Package list is stale or invalid");
    }
    return packages;
  }

  async setPackageEnabled(packageId: string, enabled: boolean): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "setPackageEnabled",
      packageId,
      enabled,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "setModel", provider, modelId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async setThinkingLevel(level: ThinkingLevelReadModel): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "setThinkingLevel", level, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async switchSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "switchSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "deleteSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async timeline(action: "restore" | "fork" | "clear", checkpointId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "timeline", action, ...(checkpointId ? { checkpointId } : {}), commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async answerUi(request: UiRequestReadModel, body: Record<string, unknown>): Promise<void> {
    const runtime = this.requireReadyRuntime();
    if (!request.owned) throw new Error("This dialog belongs to another tab");
    await this.api.uiResponse(request.requestId, { ...body, requestId: request.requestId, sessionGeneration: runtime.sessionGeneration, method: request.method });
  }

  async changeUiOwnership(request: UiRequestReadModel, action: "claim" | "release"): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.api.uiOwnership(request.requestId, runtime.sessionGeneration, action);
  }

  private async sendCommand(command: WebCommand): Promise<void> {
    try { await this.api.command(command); }
    catch (error) { this.set({ ...this.snapshot, error: error instanceof Error ? error.message : "Command failed" }); throw error; }
  }

  private requireReadyRuntime(): RuntimeSnapshot {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected" || !runtime.ready) throw new Error("Runtime is not connected");
    return runtime;
  }

  private async bootstrap(): Promise<void> {
    const epoch = ++this.bootstrapEpoch;
    try {
      const boot = await this.api.bootstrap();
      if (boot.protocolVersion !== PROTOCOL_VERSION || boot.runtime.protocolVersion !== PROTOCOL_VERSION || !Number.isSafeInteger(boot.sequence)) throw new Error("Unsupported runtime protocol");
      if (this.disposed || epoch !== this.bootstrapEpoch) return;
      this.resetting = false;
      this.set({ connection: "disconnected", runtime: boot.runtime, pendingUi: boot.pendingUi, sequence: boot.sequence, generation: boot.runtime.sessionGeneration });
      this.openEvents(`${boot.runtime.sessionGeneration}:${boot.sequence}`);
    } catch (error) {
      if (epoch !== this.bootstrapEpoch) return;
      this.resetting = false;
      if (!this.disposed) this.set({ ...this.snapshot, connection: "error", error: error instanceof Error ? error.message : "Unable to connect" });
    }
  }

  private openEvents(cursor: string): void {
    this.source?.close();
    const source = this.api.events(cursor);
    this.source = source;
    source.onopen = () => { if (this.source === source) this.set({ ...this.snapshot, connection: "connected", error: undefined }); };
    source.onerror = () => {
      if (this.source !== source || this.disposed) return;
      if (source.readyState === EventSource.CLOSED) {
        this.reset();
        return;
      }
      // EventSource handles temporary network reconnects itself.
      this.set({ ...this.snapshot, connection: "disconnected" });
    };
    for (const name of eventNames) source.addEventListener(name, (event) => {
      if (this.source === source) this.onEvent(name, event);
    });
  }

  private onEvent(name: string, event: Event): void {
    if (name === "stream.reset-required") { this.reset(); return; }
    const data = (event as MessageEvent<string>).data;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (!isWebEvent(parsed)) return;
    this.apply(parsed);
  }

  private apply(event: WebEvent): void {
    if (event.payloadVersion !== 1) { this.reset(); return; }
    const current = this.snapshot;
    const generation = current.generation;
    if (generation !== undefined && event.sessionGeneration < generation) return;
    if (event.sessionGeneration === generation && event.sequence <= current.sequence) return;
    if (event.sessionGeneration === generation && event.sequence !== current.sequence + 1) {
      this.reset(); return;
    }
    if (generation !== undefined && event.sessionGeneration > generation && event.type !== "session.replaced") {
      this.reset(); return;
    }

    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      this.reset();
      return;
    }
    if (event.type === "session.status") {
      const status = asRecord(event.payload);
      if (typeof status.sessionId === "string" && ["sleeping", "idle", "running", "attention"].includes(String(status.state))) {
        this.set({
          ...current,
          sessionStatuses: { ...current.sessionStatuses, [status.sessionId]: status.state as SessionRuntimeState },
          sequence: event.sequence,
        }, true);
      }
      return;
    }

    let runtime = current.runtime;
    let pendingUi = current.pendingUi;
    if (runtime) {
      runtime = applyRuntimeEvent(runtime, event);
      if (event.type === "ui.request") pendingUi = event.payload as UiRequestReadModel;
      if (event.type === "ui.ownership" && pendingUi) {
        const ownership = asRecord(event.payload);
        if (ownership.requestId === pendingUi.requestId) pendingUi = {
          ...pendingUi,
          owned: ownership.owned === true,
          ownershipAvailable: ownership.ownershipAvailable === true,
        };
      }
      if (event.type === "ui.closed") pendingUi = undefined;
    }
    this.set({ ...current, runtime, pendingUi, generation: event.sessionGeneration, sequence: event.sequence, agentActive: event.type === "agent.start" ? true : event.type === "agent.end" ? false : current.agentActive, connection: "connected", error: undefined }, true);
  }

  private reset(): void {
    if (this.resetting || this.disposed) return;
    this.resetting = true;
    this.source?.close();
    this.source = undefined;
    this.set({
      ...this.snapshot,
      connection: "disconnected",
      runtime: this.snapshot.runtime ? { ...this.snapshot.runtime, ready: false } : undefined,
      pendingUi: undefined,
      agentActive: false,
      error: undefined,
    });
    void this.bootstrap();
  }

  private set(next: RuntimeStoreSnapshot, batched = false): void {
    this.snapshot = next;
    if (!batched) { this.notify(); return; }
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.notify(); });
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}

function applyRuntimeEvent(runtime: RuntimeSnapshot, event: WebEvent): RuntimeSnapshot {
  const payload = event.payload;
  const conversation = runtime.conversation;
  if (event.type.startsWith("operational.")) return { ...runtime, operational: payload as OperationalReadModel };
  switch (event.type) {
    case "message.start": {
      const item = payload as MessageReadModel;
      return { ...runtime, conversation: { ...conversation, streaming: true, messages: [...conversation.messages.filter((message) => message.id !== item.id), item].slice(-100) } };
    }
    case "message.update": {
      const update = payload as { id?: string; text?: string };
      if (!update.id) return runtime;
      const messages = conversation.messages.map((message) => message.id === update.id ? { ...message, text: typeof update.text === "string" ? update.text : message.text, streaming: true } : message);
      return { ...runtime, conversation: { ...conversation, streaming: true, messages } };
    }
    case "message.end": {
      const update = payload as { id?: string; text?: string };
      const messages = conversation.messages.map((message) => message.id === update.id ? { ...message, text: typeof update.text === "string" ? update.text : message.text, streaming: false } : message);
      return { ...runtime, conversation: { ...conversation, streaming: false, messages } };
    }
    case "tool.start": return { ...runtime, conversation: { ...conversation, tools: replaceTool(conversation.tools, payload as ToolActivityReadModel) } };
    case "tool.end": return { ...runtime, conversation: { ...conversation, tools: replaceTool(conversation.tools, payload as ToolActivityReadModel) } };
    case "session.controls": return { ...runtime, sessionControls: payload as SessionControlsReadModel };
    case "queue.update": return { ...runtime, conversation: { ...conversation, queue: payload as ConversationReadModel["queue"] } };
    case "retry.update": return { ...runtime, conversation: { ...conversation, retry: payload as ConversationReadModel["retry"] } };
    case "compaction.update": return { ...runtime, conversation: { ...conversation, compaction: payload as ConversationReadModel["compaction"] } };
    case "metrics.update": return { ...runtime, metrics: payload as SessionMetricsReadModel };
    case "ui.notify": return { ...runtime, extensionUi: { ...runtime.extensionUi, notifications: [...runtime.extensionUi.notifications.filter((item) => item.id !== (payload as { id?: string }).id), payload as RuntimeSnapshot["extensionUi"]["notifications"][number]].slice(-10) } };
    case "ui.status": {
      const item = payload as { key?: string; text?: string };
      if (!item.key) return runtime;
      const statuses = runtime.extensionUi.statuses.filter((old) => old.key !== item.key);
      if (typeof item.text === "string") statuses.push({ key: item.key, text: item.text });
      return { ...runtime, extensionUi: { ...runtime.extensionUi, statuses } };
    }
    case "ui.widget": {
      const item = payload as { key?: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
      if (!item.key) return runtime;
      const widgets = runtime.extensionUi.widgets.filter((old) => old.key !== item.key);
      if (Array.isArray(item.lines)) widgets.push({ key: item.key, lines: item.lines, placement: item.placement });
      return { ...runtime, extensionUi: { ...runtime.extensionUi, widgets } };
    }
    case "ui.title": return { ...runtime, extensionUi: { ...runtime.extensionUi, title: typeof (payload as { title?: unknown }).title === "string" ? (payload as { title: string }).title : undefined } };
    case "ui.editor-text": {
      const item = payload as { text?: unknown; revision?: unknown };
      if (typeof item.text !== "string" || !Number.isSafeInteger(item.revision)) return runtime;
      return { ...runtime, extensionUi: { ...runtime.extensionUi, editorText: item.text, editorRevision: item.revision as number } };
    }
    default: return runtime;
  }
}
function replaceTool(tools: ToolActivityReadModel[], tool: ToolActivityReadModel): ToolActivityReadModel[] { return [...tools.filter((item) => item.id !== tool.id), tool].slice(-100); }

export const runtimeStore = new RuntimeEventStore();
export function useRuntimeStore(): RuntimeStoreSnapshot { return useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot, runtimeStore.getSnapshot); }
