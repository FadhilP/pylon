import type { AcceptedCommand, QueuedPromptPayload, WebCommand } from "../../shared/protocol/commands";
import type { HeliosBrowserCommand, HeliosBrowserResult } from "../../shared/protocol/helios";
import type {
  HeliosAndroidToolingCommand,
  HeliosAndroidToolingResult,
} from "../../shared/protocol/helios-android-tooling";
import type {
  ArchiveListQuery,
  ArchiveListSnapshot,
  BootstrapSnapshot,
  ConversationAttachmentContent,
  ConversationHistoryPage,
  ConversationTurnIndexPage,
  ConversationTurnIndexQuery,
  ExtensionListSnapshot,
  FileSuggestionList,
  HookSettingsSnapshot,
  PackageListSnapshot,
  PapercutListPage,
  PapercutMutationResult,
  PapercutStatusReadModel,
  SessionListQuery,
  SessionListSnapshot,
  SkillListSnapshot,
  UsageQuery,
  UsageSnapshot,
  StateQLRowsPage,
  StateQLSnapshot,
  TimelineCheckpointDiff,
  TimelineCheckpointFiles,
  TurnDiffResult,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFilePage,
} from "../../shared/protocol/snapshots";

const TAB_KEY = "pylon-tab-id";
let memoryTabId: string | undefined;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem(TAB_KEY, created);
    return created;
  } catch {
    // Private browsing can deny storage; retain one ID for this page lifetime.
    return (memoryTabId ??= randomId());
  }
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}
async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok)
    throw new ApiHttpError(
      response.status,
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    );
  return body as T;
}

/** Thin HTTP transport. POSTs deliberately have no retry behaviour. */
export class ApiClient {
  readonly tabId = tabId();
  private csrfToken?: string;

  async bootstrap(): Promise<BootstrapSnapshot> {
    const snapshot = await json<BootstrapSnapshot>(
      await fetch("/api/v1/bootstrap", { headers: { "x-pylon-tab-id": this.tabId }, credentials: "same-origin" }),
    );
    this.csrfToken = snapshot.csrfToken;
    return snapshot;
  }

  events(cursor: string): EventSource {
    const query = new URLSearchParams({ tabId: this.tabId, cursor });
    return new EventSource(`/api/v1/events?${query.toString()}`, { withCredentials: true });
  }

  terminalUrl(generation: number): string {
    if (!this.csrfToken) throw new Error("Runtime has not finished bootstrapping");
    const url = new URL("/api/v1/terminal", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({
      tabId: this.tabId,
      generation: String(generation),
      csrf: this.csrfToken,
    }).toString();
    return url.toString();
  }

  heliosBrowserStreamUrl(generation: number, width: number, height: number): string {
    if (!this.csrfToken) throw new Error("Runtime has not finished bootstrapping");
    const query = new URLSearchParams({
      tabId: this.tabId,
      generation: String(generation),
      csrf: this.csrfToken,
      width: String(width),
      height: String(height),
    });
    return `/api/v1/helios-browser-stream?${query.toString()}`;
  }

  async sessions(input: SessionListQuery = {}, signal?: AbortSignal): Promise<SessionListSnapshot> {
    const query = new URLSearchParams();
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.query) query.set("q", input.query);
    if (input.limit) query.set("limit", String(input.limit));
    return json<SessionListSnapshot>(
      await fetch(`/api/v1/sessions${query.size ? `?${query}` : ""}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
        signal,
      }),
    );
  }

  async usage(input: UsageQuery = {}, signal?: AbortSignal): Promise<UsageSnapshot> {
    const query = new URLSearchParams();
    if (input.days) query.set("days", String(input.days));
    if (input.from) query.set("from", input.from);
    if (input.through) query.set("through", input.through);
    return json<UsageSnapshot>(
      await fetch(`/api/v1/usage${query.size ? `?${query}` : ""}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
        signal,
      }),
    );
  }

  async conversationHistory(
    cursor: string,
    generation: number,
    limit = 100,
    direction: "before" | "after" | "around" = "before",
  ): Promise<ConversationHistoryPage> {
    const query = new URLSearchParams({ cursor, generation: String(generation), limit: String(limit), direction });
    return json<ConversationHistoryPage>(
      await fetch(`/api/v1/conversation-history?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async conversationAttachment(
    sourceEntryId: string,
    index: number,
    generation: number,
    signal?: AbortSignal,
  ): Promise<ConversationAttachmentContent> {
    const query = new URLSearchParams({ entry: sourceEntryId, index: String(index), generation: String(generation) });
    return json<ConversationAttachmentContent>(
      await fetch(`/api/v1/conversation-attachment?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
        signal,
      }),
    );
  }

  async conversationTurnIndex(
    input: ConversationTurnIndexQuery,
    generation: number,
  ): Promise<ConversationTurnIndexPage> {
    const query = new URLSearchParams({ generation: String(generation), limit: String(input.limit ?? 250) });
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.direction) query.set("direction", input.direction);
    return json<ConversationTurnIndexPage>(
      await fetch(`/api/v1/conversation-turns?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async fileSuggestions(queryValue: string, generation: number, limit = 15): Promise<FileSuggestionList> {
    const query = new URLSearchParams({ q: queryValue, generation: String(generation), limit: String(limit) });
    return json<FileSuggestionList>(
      await fetch(`/api/v1/file-suggestions?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async workspaceFiles(
    generation: number,
    queryValue = "",
    cursor?: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<WorkspaceFilePage> {
    const query = new URLSearchParams({ generation: String(generation), limit: "200" });
    if (queryValue) query.set("q", queryValue);
    if (cursor) query.set("cursor", cursor);
    if (refresh) query.set("refresh", "1");
    return json<WorkspaceFilePage>(
      await fetch(`/api/v1/workspace/files?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
        signal,
      }),
    );
  }

  async workspaceFile(
    generation: number,
    path: string,
    view: "current" | "base" = "current",
  ): Promise<WorkspaceFileContent> {
    const query = new URLSearchParams({ generation: String(generation), path, view });
    return json<WorkspaceFileContent>(
      await fetch(`/api/v1/workspace/file?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async workspaceDiff(generation: number, path: string): Promise<WorkspaceFileDiff> {
    const query = new URLSearchParams({ generation: String(generation), path });
    return json<WorkspaceFileDiff>(
      await fetch(`/api/v1/workspace/diff?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async turnDiff(generation: number, entryId: string): Promise<TurnDiffResult> {
    const query = new URLSearchParams({ generation: String(generation), entry: entryId });
    return json<TurnDiffResult>(
      await fetch(`/api/v1/turn-diff?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async timelineCheckpointFiles(generation: number, checkpointId: string): Promise<TimelineCheckpointFiles> {
    const query = new URLSearchParams({ generation: String(generation), checkpointId });
    return json<TimelineCheckpointFiles>(
      await fetch(`/api/v1/timeline/files?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async timelineCheckpointDiff(
    generation: number,
    checkpointId: string,
    path: string,
  ): Promise<TimelineCheckpointDiff> {
    const query = new URLSearchParams({ generation: String(generation), checkpointId, path });
    return json<TimelineCheckpointDiff>(
      await fetch(`/api/v1/timeline/diff?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async queuedPrompt(queueId: string, generation: number): Promise<QueuedPromptPayload> {
    const query = new URLSearchParams({ queueId, generation: String(generation) });
    return json<QueuedPromptPayload>(
      await fetch(`/api/v1/queued-prompt?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async packages(): Promise<PackageListSnapshot> {
    return json<PackageListSnapshot>(
      await fetch("/api/v1/packages", { headers: { "x-pylon-tab-id": this.tabId }, credentials: "same-origin" }),
    );
  }

  async extensions(): Promise<ExtensionListSnapshot> {
    return json<ExtensionListSnapshot>(
      await fetch("/api/v1/extensions", { headers: { "x-pylon-tab-id": this.tabId }, credentials: "same-origin" }),
    );
  }

  async skills(): Promise<SkillListSnapshot> {
    return json<SkillListSnapshot>(
      await fetch("/api/v1/skills", { headers: { "x-pylon-tab-id": this.tabId }, credentials: "same-origin" }),
    );
  }

  async hooks(): Promise<HookSettingsSnapshot> {
    return json<HookSettingsSnapshot>(
      await fetch("/api/v1/hooks", { headers: { "x-pylon-tab-id": this.tabId }, credentials: "same-origin" }),
    );
  }

  async stateqlSnapshot(generation: number, historyLimit = 50, signal?: AbortSignal): Promise<StateQLSnapshot> {
    const query = new URLSearchParams({ generation: String(generation), historyLimit: String(historyLimit) });
    return json<StateQLSnapshot>(
      await fetch(`/api/v1/stateql?${query}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
        signal,
      }),
    );
  }

  async stateqlRows(
    generation: number,
    handle: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<StateQLRowsPage> {
    return json<StateQLRowsPage>(
      await fetch("/api/v1/stateql/rows", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify({ generation, handle, offset, limit }),
        signal,
      }),
    );
  }

  async papercuts(
    generation: number,
    status: PapercutStatusReadModel | "all",
    query: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PapercutListPage> {
    return json<PapercutListPage>(
      await fetch("/api/v1/papercuts", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify({ generation, status, query, offset, limit }),
        signal,
      }),
    );
  }

  async mutatePapercut(
    generation: number,
    input: { action: "edit" | "delete"; id: string; expectedUpdatedAt: string; message?: string },
  ): Promise<PapercutMutationResult> {
    return json<PapercutMutationResult>(
      await fetch("/api/v1/papercuts/mutate", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify({ generation, ...input }),
      }),
    );
  }

  async archives(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.query) query.set("q", input.query);
    if (input.limit) query.set("limit", String(input.limit));
    return json<ArchiveListSnapshot>(
      await fetch(`/api/v1/archives${query.size ? `?${query}` : ""}`, {
        headers: { "x-pylon-tab-id": this.tabId },
        credentials: "same-origin",
      }),
    );
  }

  async heliosBrowser(command: HeliosBrowserCommand, signal?: AbortSignal): Promise<HeliosBrowserResult> {
    return json<HeliosBrowserResult>(
      await fetch("/api/v1/helios-browser", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify(command),
        signal,
      }),
    );
  }

  async heliosAndroidTooling(
    command: HeliosAndroidToolingCommand,
    signal?: AbortSignal,
  ): Promise<HeliosAndroidToolingResult> {
    return json<HeliosAndroidToolingResult>(
      await fetch("/api/v1/helios-android-tooling", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify(command),
        signal,
      }),
    );
  }

  async command(command: WebCommand): Promise<AcceptedCommand> {
    return json<AcceptedCommand>(
      await fetch("/api/v1/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify(command),
      }),
    );
  }

  async uiResponse(requestId: string, response: Record<string, unknown>): Promise<void> {
    await json(
      await fetch(`/api/v1/ui-responses/${encodeURIComponent(requestId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify(response),
      }),
    );
  }

  async uiOwnership(requestId: string, sessionGeneration: number, action: "claim" | "release"): Promise<void> {
    await json(
      await fetch(`/api/v1/ui-ownership/${encodeURIComponent(requestId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify({ sessionGeneration, action }),
      }),
    );
  }

  async uiKeepAlive(requestId: string, sessionGeneration: number): Promise<{ expiresAt?: string }> {
    return json(
      await fetch(`/api/v1/ui-keepalive/${encodeURIComponent(requestId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: this.headers(),
        body: JSON.stringify({ sessionGeneration }),
      }),
    );
  }

  private headers(): HeadersInit {
    if (!this.csrfToken) throw new Error("Runtime has not finished bootstrapping");
    return { "content-type": "application/json", "x-pylon-csrf": this.csrfToken, "x-pylon-tab-id": this.tabId };
  }
}
