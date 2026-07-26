import { randomUUID } from "node:crypto";
import type { ExtensionUiReadModel, UiNotificationReadModel, UiStatusReadModel, UiWidgetReadModel } from "../../shared/protocol/events.ts";
import type {
  AutocompleteProviderFactory,
  ExtensionUIDialogOptions,
  ExtensionUIContext,
  ExtensionWidgetOptions,
  TerminalInputHandler,
  Theme,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

export type DialogMethod = "select" | "confirm" | "input" | "editor";
export type UiMethod = DialogMethod | "notify" | "setStatus" | "setWidget" | "setTitle" | "setEditorText";

export interface UiRequest {
  kind: "request";
  requestId: string;
  sessionId: string;
  sessionGeneration: number;
  method: UiMethod;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
}

export interface UiResponse {
  requestId: string;
  sessionGeneration: number;
  method: DialogMethod;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
}

interface PendingDialog {
  request: UiRequest;
  neutral: unknown;
  options?: string[];
  resolve(value: unknown): void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

type EditorFactory = ReturnType<ExtensionUIContext["getEditorComponent"]>;

const MAX_TEXT = 64 * 1024;
const MAX_EVENT_TEXT = 48 * 1024;
const MAX_OPTIONS = 50;

function bounded(value: string, maximum = 4_000): string {
  return value.slice(0, maximum);
}

function boundedLines(lines: string[]): string[] {
  const result: string[] = [];
  let remaining = 8 * 1024;
  for (const line of lines.slice(0, 40)) {
    const item = bounded(line, Math.min(500, remaining));
    result.push(item);
    remaining -= item.length;
    if (remaining <= 0) break;
  }
  return result;
}

function emptyState(): ExtensionUiReadModel {
  return { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 };
}

function replaceKey<T extends { key: string }>(items: T[], key: string, item: T | undefined, maximum: number): T[] {
  const next = items.filter((existing) => existing.key !== key);
  if (item) next.push(item);
  return next.slice(-maximum);
}

export class RemoteUiBridge {
  readonly ready = true;
  private readonly pending = new Map<string, PendingDialog>();
  private activeGeneration?: number;
  private state: ExtensionUiReadModel = emptyState();

  constructor(
    private readonly publish: (request: UiRequest) => void,
    private readonly defaultTimeoutMs = 60_000,
    private readonly publishClosed: (request: UiRequest) => void = () => {},
  ) {}

  context(sessionId: string, sessionGeneration: number): ExtensionUIContext {
    if (this.activeGeneration !== sessionGeneration) {
      this.activeGeneration = sessionGeneration;
      this.state = emptyState();
    }
    return new GenerationUiContext(this, sessionId, sessionGeneration);
  }

  snapshot(): ExtensionUiReadModel {
    return {
      ...this.state,
      notifications: this.state.notifications.map((item) => ({ ...item })),
      statuses: this.state.statuses.map((item) => ({ ...item })),
      widgets: this.state.widgets.map((item) => ({ ...item, lines: [...item.lines] })),
    };
  }

  get hasPendingDialog(): boolean {
    return this.pending.size > 0;
  }

  emit(
    sessionId: string,
    sessionGeneration: number,
    method: UiMethod,
    payload: Record<string, unknown>,
  ): void {
    if (sessionGeneration !== this.activeGeneration) return;
    const request: UiRequest = {
      kind: "request",
      requestId: randomUUID(),
      sessionId,
      sessionGeneration,
      method,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.retain(request);
    this.publish(request);
  }

  dialog<T>(input: {
    sessionId: string;
    sessionGeneration: number;
    method: DialogMethod;
    payload: Record<string, unknown>;
    neutral: T;
    options?: string[];
    dialogOptions?: ExtensionUIDialogOptions;
  }): Promise<T> {
    const { dialogOptions } = input;
    if (input.sessionGeneration !== this.activeGeneration || dialogOptions?.signal?.aborted || this.pending.size > 0) return Promise.resolve(input.neutral);

    const requestId = randomUUID();
    const timeoutMs = Math.max(1, Math.min(dialogOptions?.timeout ?? this.defaultTimeoutMs, this.defaultTimeoutMs));
    const request: UiRequest = {
      kind: "request",
      requestId,
      sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration,
      method: input.method,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    };

    return new Promise<T>((resolve) => {
      const finish = (value: unknown) => {
        this.clear(requestId);
        resolve(value as T);
      };
      const pending: PendingDialog = {
        request,
        neutral: input.neutral,
        options: input.options,
        resolve: finish,
      };
      pending.timer = setTimeout(() => finish(input.neutral), timeoutMs);
      pending.timer.unref?.();
      if (dialogOptions?.signal) {
        pending.signal = dialogOptions.signal;
        pending.abort = () => finish(input.neutral);
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(requestId, pending);
      this.publish(request);
    });
  }

  answer(response: UiResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) throw new Error("unknown or expired UI request");
    if (response.sessionGeneration !== pending.request.sessionGeneration || response.method !== pending.request.method) {
      throw new Error("UI response does not match request generation or method");
    }
    if (pending.request.expiresAt && Date.parse(pending.request.expiresAt) <= Date.now()) {
      pending.resolve(pending.neutral);
      throw new Error("unknown or expired UI request");
    }
    if (response.cancelled) return pending.resolve(pending.neutral);

    switch (pending.request.method) {
      case "confirm":
        if (typeof response.confirmed !== "boolean") throw new Error("confirm response requires confirmed");
        pending.resolve(response.confirmed);
        return;
      case "select":
        if (typeof response.value !== "string" || !pending.options?.includes(response.value)) {
          throw new Error("select response must be an offered option");
        }
        pending.resolve(response.value);
        return;
      case "input":
      case "editor":
        if (typeof response.value !== "string" || response.value.length > MAX_TEXT) {
          throw new Error("text response is invalid or too large");
        }
        pending.resolve(response.value);
    }
  }

  private retain(request: UiRequest): void {
    const payload = request.payload;
    if (request.method === "notify") {
      const item: UiNotificationReadModel = {
        id: request.requestId,
        message: typeof payload.message === "string" ? payload.message : "",
        type: payload.type === "warning" || payload.type === "error" ? payload.type : "info",
        occurredAt: request.createdAt,
      };
      this.state.notifications = [...this.state.notifications, item].slice(-10);
    } else if (request.method === "setStatus" && typeof payload.key === "string") {
      const item = typeof payload.text === "string" ? { key: payload.key, text: payload.text } satisfies UiStatusReadModel : undefined;
      this.state.statuses = replaceKey(this.state.statuses, payload.key, item, 25);
    } else if (request.method === "setWidget" && typeof payload.key === "string") {
      const placement = payload.placement === "aboveEditor" || payload.placement === "belowEditor" ? payload.placement : undefined;
      const item = Array.isArray(payload.lines) ? { key: payload.key, lines: payload.lines as string[], placement } satisfies UiWidgetReadModel : undefined;
      this.state.widgets = replaceKey(this.state.widgets, payload.key, item, 10);
    } else if (request.method === "setTitle" && typeof payload.title === "string") {
      this.state.title = payload.title;
    } else if (request.method === "setEditorText" && typeof payload.text === "string") {
      this.state.editorText = payload.text;
      this.state.editorRevision++;
    }
  }

  cancelGeneration(sessionGeneration: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionGeneration === sessionGeneration) pending.resolve(pending.neutral);
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.resolve(pending.neutral);
  }

  private clear(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    this.publishClosed(pending.request);
  }
}

class GenerationUiContext implements ExtensionUIContext {
  constructor(
    private readonly bridge: RemoteUiBridge,
    private readonly sessionId: string,
    private readonly generation: number,
  ) {}

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const offered = options.slice(0, MAX_OPTIONS).map((option) => bounded(option, 500));
    return this.bridge.dialog({
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      method: "select",
      payload: { title: bounded(title), options: offered },
      neutral: undefined,
      options: offered,
      dialogOptions: opts,
    });
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.bridge.dialog({
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      method: "confirm",
      payload: { title: bounded(title), message: bounded(message) },
      neutral: false,
      dialogOptions: opts,
    });
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.bridge.dialog({
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      method: "input",
      payload: { title: bounded(title), placeholder: placeholder && bounded(placeholder) },
      neutral: undefined,
      dialogOptions: opts,
    });
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.bridge.dialog({
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      method: "editor",
      payload: { title: bounded(title), prefill: prefill && bounded(prefill, MAX_EVENT_TEXT) },
      neutral: undefined,
    });
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.bridge.emit(this.sessionId, this.generation, "notify", { message: bounded(message, 2_000), type });
  }
  onTerminalInput(_handler: TerminalInputHandler): () => void { return () => {}; }
  setStatus(key: string, text: string | undefined): void {
    this.bridge.emit(this.sessionId, this.generation, "setStatus", { key: bounded(key, 100) || "status", text: text === undefined ? undefined : bounded(text, 500) });
  }
  setWorkingMessage(_message?: string): void {}
  setWorkingVisible(_visible: boolean): void {}
  setWorkingIndicator(_options?: WorkingIndicatorOptions): void {}
  setHiddenThinkingLabel(_label?: string): void {}
  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    if (content === undefined || Array.isArray(content)) {
      this.bridge.emit(this.sessionId, this.generation, "setWidget", {
        key: bounded(key, 100) || "widget",
        lines: content && boundedLines(content),
        placement: options?.placement,
      });
    }
  }
  setFooter(_factory: unknown): void {}
  setHeader(_factory: unknown): void {}
  setTitle(title: string): void { this.bridge.emit(this.sessionId, this.generation, "setTitle", { title: bounded(title, 500) }); }
  async custom<T>(_factory: unknown, _options?: unknown): Promise<T> { return undefined as T; }
  pasteToEditor(text: string): void { this.setEditorText(text); }
  setEditorText(text: string): void { this.bridge.emit(this.sessionId, this.generation, "setEditorText", { text: bounded(text, MAX_EVENT_TEXT) }); }
  getEditorText(): string { return ""; }
  addAutocompleteProvider(_factory: AutocompleteProviderFactory): void {}
  setEditorComponent(_factory: EditorFactory | undefined): void {}
  getEditorComponent(): EditorFactory | undefined { return undefined; }
  get theme(): Theme { return undefined as unknown as Theme; }
  getAllThemes(): Array<{ name: string; path: string | undefined }> { return []; }
  getTheme(_name: string): Theme | undefined { return undefined; }
  setTheme(_theme: string | Theme): { success: boolean; error?: string } {
    return { success: false, error: "Theme switching is unavailable in remote UI mode" };
  }
  getToolsExpanded(): boolean { return false; }
  setToolsExpanded(_expanded: boolean): void {}
}
