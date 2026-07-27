import type { AcceptedCommand, QueuedPromptPayload, WebCommand } from "../../shared/protocol/commands";
import type { ArchiveListQuery, ArchiveListSnapshot, BootstrapSnapshot, ConversationHistoryPage, FileSuggestionList, PackageListSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots";

const TAB_KEY = "pylon-tab-id";
let memoryTabId: string | undefined;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    return memoryTabId ??= randomId();
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body as T;
}

/** Thin HTTP transport. POSTs deliberately have no retry behaviour. */
export class ApiClient {
  readonly tabId = tabId();
  private csrfToken?: string;

  async bootstrap(): Promise<BootstrapSnapshot> {
    const snapshot = await json<BootstrapSnapshot>(await fetch("/api/v1/bootstrap", {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
    this.csrfToken = snapshot.csrfToken;
    return snapshot;
  }

  events(cursor: string): EventSource {
    const query = new URLSearchParams({ tabId: this.tabId, cursor });
    return new EventSource(`/api/v1/events?${query.toString()}`, { withCredentials: true });
  }

  async sessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    const query = new URLSearchParams();
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.query) query.set("q", input.query);
    if (input.limit) query.set("limit", String(input.limit));
    return json<SessionListSnapshot>(await fetch(`/api/v1/sessions${query.size ? `?${query}` : ""}`, {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async conversationHistory(cursor: string, generation: number, limit = 100): Promise<ConversationHistoryPage> {
    const query = new URLSearchParams({ cursor, generation: String(generation), limit: String(limit) });
    return json<ConversationHistoryPage>(await fetch(`/api/v1/conversation-history?${query}`, {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async fileSuggestions(queryValue: string, generation: number, limit = 8): Promise<FileSuggestionList> {
    const query = new URLSearchParams({ q: queryValue, generation: String(generation), limit: String(limit) });
    return json<FileSuggestionList>(await fetch(`/api/v1/file-suggestions?${query}`, {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async queuedPrompt(queueId: string, generation: number): Promise<QueuedPromptPayload> {
    const query = new URLSearchParams({ queueId, generation: String(generation) });
    return json<QueuedPromptPayload>(await fetch(`/api/v1/queued-prompt?${query}`, {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async packages(): Promise<PackageListSnapshot> {
    return json<PackageListSnapshot>(await fetch("/api/v1/packages", {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async archives(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.query) query.set("q", input.query);
    if (input.limit) query.set("limit", String(input.limit));
    return json<ArchiveListSnapshot>(await fetch(`/api/v1/archives${query.size ? `?${query}` : ""}`, {
      headers: { "x-pylon-tab-id": this.tabId },
      credentials: "same-origin",
    }));
  }

  async command(command: WebCommand): Promise<AcceptedCommand> {
    return json<AcceptedCommand>(await fetch("/api/v1/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: this.headers(),
      body: JSON.stringify(command),
    }));
  }

  async uiResponse(requestId: string, response: Record<string, unknown>): Promise<void> {
    await json(await fetch(`/api/v1/ui-responses/${encodeURIComponent(requestId)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: this.headers(),
      body: JSON.stringify(response),
    }));
  }

  async uiOwnership(requestId: string, sessionGeneration: number, action: "claim" | "release"): Promise<void> {
    await json(await fetch(`/api/v1/ui-ownership/${encodeURIComponent(requestId)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: this.headers(),
      body: JSON.stringify({ sessionGeneration, action }),
    }));
  }

  private headers(): HeadersInit {
    if (!this.csrfToken) throw new Error("Runtime has not finished bootstrapping");
    return {
      "content-type": "application/json",
      "x-pylon-csrf": this.csrfToken,
      "x-pylon-tab-id": this.tabId,
    };
  }
}
