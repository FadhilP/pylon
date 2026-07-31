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

export type DialogMethod = "select" | "confirm" | "input" | "editor" | "questionnaire";
export interface QuestionnaireQuestion { question: string; options: string[]; }
export type UiMethod = DialogMethod | "notify" | "setStatus" | "setWidget" | "setTitle" | "setEditorText";

export interface UiRequest {
  kind: "request";
  requestId: string;
  sessionId: string;
  sessionGeneration: number;
  method: UiMethod;
  payload: Record<string, unknown>;
  createdAt: string;
  timeoutSeconds?: number;
  expiresAt?: string;
}

export type ProviderAuthPrompt = {
  signal?: AbortSignal;
} & ({
  type: "text" | "secret" | "manual_code";
  message: string;
  placeholder?: string;
} | {
  type: "select";
  message: string;
  options: readonly { id: string; label: string; description?: string }[];
});

export interface UiResponse {
  requestId: string;
  sessionGeneration: number;
  method: DialogMethod;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
  answers?: string[];
}

export type StateQLCredentialAccess = "read" | "write";
export type StateQLCredentialOperation = "connect" | "query" | "inspect" | "plan" | "exec" | "apply" | "transaction.commit";
export interface StateQLCredentialRequest {
  reference: string;
  actorId: string;
  session: { id: string; name: string };
  operation: StateQLCredentialOperation;
  access: StateQLCredentialAccess;
  signal?: AbortSignal;
  profile?: { name: string };
  requestedReadOnly?: boolean;
  connection?: {
    id: string;
    name: string;
    driver: "sqlite" | "postgres" | "mysql";
    database: string;
    readOnly: boolean;
  };
}

export interface StateQLPasswordTarget {
  driver: "postgres" | "mysql";
  username: string;
  hostname: string;
  port: number;
  database: string;
}

export interface StateQLCredentialHost {
  requestStateQLCredential(request: StateQLCredentialRequest): Promise<string | undefined>;
  requestStateQLPassword(request: StateQLCredentialRequest, target: StateQLPasswordTarget): Promise<string | undefined>;
  invalidateStateQLPassword(request: StateQLCredentialRequest, target: StateQLPasswordTarget): void;
}

interface PendingDialog {
  request: UiRequest;
  neutral: unknown;
  options?: string[];
  questions?: QuestionnaireQuestion[];
  resolve(value: unknown): void;
  timer?: NodeJS.Timeout;
  timeoutMs?: number;
  signal?: AbortSignal;
  abort?: () => void;
}

type EditorFactory = ReturnType<ExtensionUIContext["getEditorComponent"]>;

const MAX_TEXT = 64 * 1024;
const MAX_EVENT_TEXT = 48 * 1024;
const MAX_OPTIONS = 50;
const STATEQL_CREDENTIAL_TTL_MS = 60 * 60_000;
const STATEQL_OPERATIONS = new Set<StateQLCredentialOperation>([
  "connect", "query", "inspect", "plan", "exec", "apply", "transaction.commit",
]);

interface CredentialIdentity {
  kind: "source" | "password";
  profile?: string;
  connection?: string;
  target?: string;
}

interface CredentialBinding {
  generation: number;
  kind: "source" | "password";
  profile?: string;
  connection?: string;
  target?: string;
  access: StateQLCredentialAccess;
  value: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

interface CredentialFlight {
  key: string;
  generation: number;
  controller: AbortController;
  promise: Promise<string | undefined>;
  waiters: number;
  settled: boolean;
}

interface CredentialDialogInput {
  sessionId: string;
  sessionGeneration: number;
  method: "input";
  payload: Record<string, unknown>;
  neutral: undefined;
  dialogOptions?: ExtensionUIDialogOptions;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`StateQL credential ${label} is invalid`);
  }
  return value;
}

function safeMetadata(value: string, maximum: number): string {
  return bounded(value, maximum)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@")
    .replace(/[\u0000-\u001f\u007f]/gu, " ");
}

function databaseSourceDriver(value: string): "sqlite" | "postgres" | "mysql" | undefined {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const sqlitePath = /^sqlite:(?!\/\/)(.*)$/iu.exec(value)?.[1];
  if (sqlitePath?.trim() && sqlitePath !== ":memory:") return "sqlite";
  const driver = /^postgres(?:ql)?:\/\//iu.test(value) ? "postgres"
    : /^mysql:\/\//iu.test(value) ? "mysql"
      : undefined;
  if (!driver) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname || url.pathname.replaceAll("/", "")) return driver;
  } catch {}
  return undefined;
}

function validateCredentialValue(request: StateQLCredentialRequest, value: string): void {
  const driver = databaseSourceDriver(value);
  if (!driver || request.connection && driver !== request.connection.driver) {
    const expected = request.connection?.driver === "postgres" ? "complete PostgreSQL connection URL"
      : request.connection?.driver === "mysql" ? "complete MySQL connection URL"
        : request.connection?.driver === "sqlite" ? "explicit sqlite:<path> source"
          : "complete PostgreSQL/MySQL URL or explicit sqlite:<path> source";
    throw new Error(`StateQL credential must use the expected source format: ${expected}`);
  }
}

function validateCredentialRequest(
  sessionId: string,
  request: StateQLCredentialRequest,
): { request: StateQLCredentialRequest; identity: CredentialIdentity } {
  if (!request || typeof request !== "object") throw new Error("StateQL credential request is invalid");
  const reference = requiredText(request.reference, "reference", 200);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) throw new Error("StateQL credential reference is invalid");
  const actorId = requiredText(request.actorId, "actor", 128);
  if (actorId !== sessionId) throw new Error("StateQL credential actor does not match this Pi session");
  const stateqlSessionId = requiredText(request.session?.id, "session", 128);
  const stateqlSessionName = requiredText(request.session?.name, "session name", 200);
  if (!STATEQL_OPERATIONS.has(request.operation) || request.access !== "read" && request.access !== "write") {
    throw new Error("StateQL credential operation is invalid");
  }
  if (request.requestedReadOnly !== undefined && typeof request.requestedReadOnly !== "boolean") {
    throw new Error("StateQL credential access metadata is invalid");
  }
  const profile = request.profile ? requiredText(request.profile.name, "profile", 200) : undefined;
  let connection: StateQLCredentialRequest["connection"];
  let canonicalConnection: string | undefined;
  if (request.connection) {
    const driver = request.connection.driver;
    if (!(["sqlite", "postgres", "mysql"] as const).includes(driver)
      || typeof request.connection.readOnly !== "boolean") {
      throw new Error("StateQL credential connection metadata is invalid");
    }
    connection = {
      id: requiredText(request.connection.id, "connection", 200),
      name: requiredText(request.connection.name, "connection name", 200),
      driver,
      database: requiredText(request.connection.database, "database", 500),
      readOnly: request.connection.readOnly,
    };
    canonicalConnection = JSON.stringify([connection.name, connection.driver, connection.database, connection.readOnly]);
  }
  return {
    request: {
      reference,
      actorId,
      session: { id: stateqlSessionId, name: stateqlSessionName },
      operation: request.operation,
      access: request.access,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(profile ? { profile: { name: profile } } : {}),
      ...(request.requestedReadOnly !== undefined ? { requestedReadOnly: request.requestedReadOnly } : {}),
      ...(connection ? { connection } : {}),
    },
    identity: { kind: "source", profile, connection: canonicalConnection },
  };
}

function validatePasswordTarget(
  request: StateQLCredentialRequest,
  target: StateQLPasswordTarget,
): { target: StateQLPasswordTarget; identity: string } {
  if (!target || typeof target !== "object" || target.driver !== "postgres" && target.driver !== "mysql") {
    throw new Error("StateQL password target is invalid");
  }
  if (request.connection && request.connection.driver !== target.driver) {
    throw new Error("StateQL password target does not match the active connection");
  }
  const username = requiredText(target.username, "username", 500);
  const hostname = requiredText(target.hostname, "hostname", 500).toLowerCase().replace(/\.$/u, "");
  if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new Error("StateQL password target port is invalid");
  }
  if (typeof target.database !== "string" || target.database.length > 500 || /[\u0000-\u001f\u007f]/u.test(target.database)) {
    throw new Error("StateQL password target database is invalid");
  }
  const value = { driver: target.driver, username, hostname, port: target.port, database: target.database };
  return { target: value, identity: JSON.stringify(Object.values(value)) };
}

function identityMatches(binding: CredentialBinding, identity: CredentialIdentity): boolean {
  if (binding.kind !== identity.kind) return false;
  if (binding.profile && identity.profile && binding.profile !== identity.profile) return false;
  if (binding.connection && identity.connection && binding.connection !== identity.connection) return false;
  if (binding.target && identity.target && binding.target !== identity.target) return false;
  return true;
}

function attachIdentity(binding: CredentialBinding, identity: CredentialIdentity): void {
  binding.profile ??= identity.profile;
  binding.connection ??= identity.connection;
  binding.target ??= identity.target;
}

function credentialBaseKey(
  generation: number,
  sessionId: string,
  request: StateQLCredentialRequest,
  identity: CredentialIdentity,
): string {
  const reference = identity.kind === "password" ? identity.target : request.reference;
  return JSON.stringify([generation, sessionId, request.actorId, request.session.id, identity.kind, reference]);
}

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

class StateQLCredentialBroker {
  private readonly bindings = new Map<string, CredentialBinding>();
  private readonly flights = new Map<string, CredentialFlight>();

  constructor(
    private readonly prompt: (input: CredentialDialogInput) => Promise<string | undefined>,
    private readonly isCurrent: (generation: number) => boolean,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  request(
    sessionId: string,
    generation: number,
    raw: StateQLCredentialRequest,
    rawPasswordTarget?: StateQLPasswordTarget,
  ): Promise<string | undefined> {
    if (!this.isCurrent(generation)) return Promise.resolve(undefined);
    const { request, identity } = validateCredentialRequest(sessionId, raw);
    const passwordTarget = rawPasswordTarget ? validatePasswordTarget(request, rawPasswordTarget) : undefined;
    if (passwordTarget) {
      identity.kind = "password";
      identity.target = passwordTarget.identity;
    }
    const baseKey = credentialBaseKey(generation, sessionId, request, identity);
    const current = this.bindings.get(baseKey);
    if (current && current.expiresAt <= this.now()) this.deleteBinding(baseKey, current);
    const binding = this.bindings.get(baseKey);
    if (binding) {
      if (!identityMatches(binding, identity)) {
        return Promise.reject(new Error("StateQL credential identity does not match the active binding"));
      }
      attachIdentity(binding, identity);
      if (binding.access === "write" || request.access === "read") return Promise.resolve(binding.value);
    }

    const flightKey = JSON.stringify([baseKey, identity.kind, identity.profile, identity.connection, identity.target, request.access]);
    let flight = this.flights.get(flightKey);
    if (!flight) {
      const controller = new AbortController();
      flight = { key: flightKey, generation, controller, promise: Promise.resolve(undefined), waiters: 0, settled: false };
      const activeFlight = flight;
      activeFlight.promise = this.ask(sessionId, generation, baseKey, request, identity, passwordTarget?.target, controller.signal)
        .finally(() => {
          activeFlight.settled = true;
          if (this.flights.get(flightKey) === activeFlight) this.flights.delete(flightKey);
        });
      this.flights.set(flightKey, activeFlight);
    }
    return this.wait(flight, request.signal);
  }

  invalidatePassword(
    sessionId: string,
    generation: number,
    raw: StateQLCredentialRequest,
    rawTarget: StateQLPasswordTarget,
  ): void {
    if (!this.isCurrent(generation)) return;
    const { request, identity } = validateCredentialRequest(sessionId, raw);
    const target = validatePasswordTarget(request, rawTarget);
    identity.kind = "password";
    identity.target = target.identity;
    const key = credentialBaseKey(generation, sessionId, request, identity);
    const binding = this.bindings.get(key);
    if (binding && identityMatches(binding, identity)) this.deleteBinding(key, binding);
  }

  clearGeneration(generation: number): void {
    for (const [key, binding] of this.bindings) {
      if (binding.generation === generation) this.deleteBinding(key, binding);
    }
    for (const [key, flight] of this.flights) {
      if (flight.generation !== generation) continue;
      this.flights.delete(key);
      flight.controller.abort();
    }
  }

  clearAll(): void {
    for (const [key, binding] of this.bindings) this.deleteBinding(key, binding);
    for (const [key, flight] of this.flights) {
      this.flights.delete(key);
      flight.controller.abort();
    }
  }

  private async ask(
    sessionId: string,
    generation: number,
    baseKey: string,
    request: StateQLCredentialRequest,
    identity: CredentialIdentity,
    passwordTarget: StateQLPasswordTarget | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const target = request.connection
      ? `${safeMetadata(request.connection.name, 120)} (${request.connection.driver}, ${safeMetadata(request.connection.database, 200)})`
      : request.profile
        ? `profile ${safeMetadata(request.profile.name, 120)}`
        : "the requested database";
    const expected = request.connection?.driver === "postgres" ? "complete PostgreSQL connection URL"
      : request.connection?.driver === "mysql" ? "complete MySQL connection URL"
        : request.connection?.driver === "sqlite" ? "explicit sqlite:<path> source"
          : "complete PostgreSQL/MySQL URL or explicit sqlite:<path> source";
    const passwordTargetLabel = passwordTarget
      ? `${safeMetadata(passwordTarget.username, 120)}@${safeMetadata(passwordTarget.hostname, 200)}:${passwordTarget.port}/${safeMetadata(passwordTarget.database || "(default)", 200)}`
      : undefined;
    const displayReference = request.reference.startsWith("PYLON_STATEQL_BROKERED_")
      ? "Pylon secure connection"
      : safeMetadata(request.reference, 200);
    const value = await this.prompt({
      sessionId,
      sessionGeneration: generation,
      method: "input",
      payload: {
        context: "stateql-credential",
        inputType: "password",
        title: passwordTarget ? "Enter database password" : "Enter database connection source",
        message: passwordTarget
          ? `Enter the password to connect to ${passwordTargetLabel} with ${request.access === "write" ? "read-write" : "read-only"} access. Database content may be sent to the selected model provider. The password stays in server memory for up to one hour.`
          : `Enter the ${expected} referenced by ${displayReference} for ${request.access} access to ${target}. It stays in server memory for up to one hour.`,
        reference: passwordTarget ? "Pylon secure password" : displayReference,
        access: request.access,
        expiresInSeconds: Math.floor(this.ttlMs / 1_000),
        ...(passwordTarget ? { username: safeMetadata(passwordTarget.username, 500), hostname: safeMetadata(passwordTarget.hostname, 500), port: passwordTarget.port, database: safeMetadata(passwordTarget.database, 500) } : {}),
        ...(request.profile ? { profile: safeMetadata(request.profile.name, 200) } : {}),
        ...(!passwordTarget && request.connection ? { database: safeMetadata(request.connection.database, 500) } : {}),
      },
      neutral: undefined,
      dialogOptions: { signal },
    });
    if (!value || !this.isCurrent(generation) || signal.aborted) return undefined;
    if (passwordTarget) {
      if (value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("StateQL password is invalid");
    } else {
      validateCredentialValue(request, value);
    }

    let binding = this.bindings.get(baseKey);
    if (binding && binding.expiresAt <= this.now()) {
      this.deleteBinding(baseKey, binding);
      binding = undefined;
    }
    if (binding && !identityMatches(binding, identity)) {
      throw new Error("StateQL credential identity does not match the active binding");
    }
    if (!binding) {
      binding = {
        generation,
        ...identity,
        access: request.access,
        value,
        expiresAt: this.now() + this.ttlMs,
      };
      this.bindings.set(baseKey, binding);
    } else {
      attachIdentity(binding, identity);
      binding.access = request.access === "write" ? "write" : binding.access;
      binding.value = value;
      binding.expiresAt = this.now() + this.ttlMs;
    }
    this.scheduleExpiry(baseKey, binding);
    return value;
  }

  private scheduleExpiry(key: string, binding: CredentialBinding): void {
    if (binding.timer) clearTimeout(binding.timer);
    binding.timer = setTimeout(() => {
      if (this.bindings.get(key) !== binding) return;
      if (binding.expiresAt > this.now()) return this.scheduleExpiry(key, binding);
      this.deleteBinding(key, binding);
    }, Math.max(1, binding.expiresAt - this.now()));
    binding.timer.unref?.();
  }

  private deleteBinding(key: string, binding: CredentialBinding): void {
    if (this.bindings.get(key) !== binding) return;
    this.bindings.delete(key);
    if (binding.timer) clearTimeout(binding.timer);
    binding.timer = undefined;
  }

  private wait(flight: CredentialFlight, signal?: AbortSignal): Promise<string | undefined> {
    flight.waiters++;
    return new Promise<string | undefined>((resolve, reject) => {
      let finished = false;
      const complete = (action: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", aborted);
        flight.waiters--;
        if (!flight.settled && flight.waiters === 0) {
          if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
          flight.controller.abort();
        }
        action();
      };
      const aborted = () => complete(() => resolve(undefined));
      if (signal?.aborted) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      flight.promise.then(
        (value) => complete(() => resolve(value)),
        (error) => complete(() => reject(error)),
      );
    });
  }
}

export class RemoteUiBridge {
  readonly ready = true;
  private readonly pending = new Map<string, PendingDialog>();
  private readonly credentialBroker: StateQLCredentialBroker;
  private activeGeneration?: number;
  private state: ExtensionUiReadModel = emptyState();
  private disposed = false;

  constructor(
    private readonly publish: (request: UiRequest) => void,
    private readonly defaultTimeoutMs = 60_000,
    private readonly publishClosed: (request: UiRequest) => void = () => {},
    credentialTtlMs = STATEQL_CREDENTIAL_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.credentialBroker = new StateQLCredentialBroker(
      (input) => this.dialog<string | undefined>(input),
      (generation) => generation === this.activeGeneration,
      credentialTtlMs,
      now,
    );
  }

  context(sessionId: string, sessionGeneration: number): ExtensionUIContext {
    if (this.disposed) return new GenerationUiContext(this, sessionId, sessionGeneration);
    if (this.activeGeneration !== sessionGeneration) {
      if (this.activeGeneration !== undefined) this.cancelGeneration(this.activeGeneration);
      this.activeGeneration = sessionGeneration;
      this.state = emptyState();
    }
    return new GenerationUiContext(this, sessionId, sessionGeneration);
  }

  async requestStateQLCredential(
    sessionId: string,
    sessionGeneration: number,
    request: StateQLCredentialRequest,
  ): Promise<string | undefined> {
    if (this.disposed) return undefined;
    return this.credentialBroker.request(sessionId, sessionGeneration, request);
  }

  async requestStateQLPassword(
    sessionId: string,
    sessionGeneration: number,
    request: StateQLCredentialRequest,
    target: StateQLPasswordTarget,
  ): Promise<string | undefined> {
    if (this.disposed) return undefined;
    return this.credentialBroker.request(sessionId, sessionGeneration, request, target);
  }

  invalidateStateQLPassword(
    sessionId: string,
    sessionGeneration: number,
    request: StateQLCredentialRequest,
    target: StateQLPasswordTarget,
  ): void {
    if (this.disposed) return;
    this.credentialBroker.invalidatePassword(sessionId, sessionGeneration, request, target);
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
    if (this.disposed || sessionGeneration !== this.activeGeneration) return;
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
    questions?: QuestionnaireQuestion[];
    dialogOptions?: ExtensionUIDialogOptions;
  }): Promise<T> {
    const { dialogOptions } = input;
    if (this.disposed || input.sessionGeneration !== this.activeGeneration || dialogOptions?.signal?.aborted || this.pending.size > 0) return Promise.resolve(input.neutral);

    const requestId = randomUUID();
    const requestedTimeout = dialogOptions?.timeout ?? this.defaultTimeoutMs;
    const timeoutMs = requestedTimeout === 0
      ? undefined
      : Math.max(1, Math.min(requestedTimeout, 24 * 60 * 60_000));
    const request: UiRequest = {
      kind: "request",
      requestId,
      sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration,
      method: input.method,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      ...(timeoutMs ? { timeoutSeconds: Math.ceil(timeoutMs / 1_000) } : {}),
      ...(timeoutMs ? { expiresAt: new Date(Date.now() + timeoutMs).toISOString() } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const finish = (value: unknown) => {
        this.clear(requestId);
        resolve(value as T);
      };
      const pending: PendingDialog = {
        request,
        neutral: input.neutral,
        options: input.options,
        questions: input.questions,
        resolve: finish,
        timeoutMs,
      };
      this.scheduleTimeout(pending);
      if (dialogOptions?.signal) {
        pending.signal = dialogOptions.signal;
        pending.abort = () => finish(input.neutral);
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(requestId, pending);
      try { this.publish(request); }
      catch (error) {
        this.releasePending(requestId);
        reject(error);
      }
    });
  }

  authPrompt(
    sessionId: string,
    sessionGeneration: number,
    prompt: ProviderAuthPrompt,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const combinedSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
    if (prompt.type === "select") {
      const options = prompt.options.slice(0, MAX_OPTIONS).map((option) => ({
        value: bounded(option.id, 500),
        label: bounded(option.label, 500),
        ...(option.description ? { description: bounded(option.description, 1_000) } : {}),
      }));
      return this.dialog({
        sessionId,
        sessionGeneration,
        method: "select",
        payload: { context: "provider-auth", title: bounded(prompt.message), options },
        neutral: undefined,
        options: options.map((option) => option.value),
        dialogOptions: { signal: combinedSignal, timeout: 0 },
      });
    }
    return this.dialog({
      sessionId,
      sessionGeneration,
      method: "input",
      payload: {
        context: "provider-auth",
        title: bounded(prompt.message),
        placeholder: prompt.placeholder && bounded(prompt.placeholder),
        inputType: prompt.type === "secret" ? "password" : "text",
      },
      neutral: undefined,
      dialogOptions: { signal: combinedSignal, timeout: 0 },
    });
  }

  answer(response: UiResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) throw new Error("unknown or expired UI request");
    if (pending.request.sessionGeneration !== this.activeGeneration) {
      pending.resolve(pending.neutral);
      throw new Error("stale UI request generation");
    }
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
        return;
      case "questionnaire":
        if (!Array.isArray(response.answers)
          || response.answers.length !== pending.questions?.length
          || response.answers.some((answer) =>
            typeof answer !== "string" || !answer.trim() || answer.length > 4_000)) {
          throw new Error("questionnaire response requires one bounded answer per question");
        }
        pending.resolve(response.answers.map((answer) => answer.trim()));
    }
  }

  keepAlive(requestId: string, sessionGeneration: number): string | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("unknown or expired UI request");
    if (pending.request.sessionGeneration !== this.activeGeneration
      || pending.request.sessionGeneration !== sessionGeneration) throw new Error("stale UI request generation");
    if (!pending.timeoutMs) return undefined;
    this.scheduleTimeout(pending);
    return pending.request.expiresAt;
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

  private scheduleTimeout(pending: PendingDialog): void {
    if (!pending.timeoutMs) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.request.expiresAt = new Date(Date.now() + pending.timeoutMs).toISOString();
    pending.timer = setTimeout(() => pending.resolve(pending.neutral), pending.timeoutMs);
    pending.timer.unref?.();
  }

  cancelGeneration(sessionGeneration: number): void {
    this.credentialBroker.clearGeneration(sessionGeneration);
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionGeneration === sessionGeneration) pending.resolve(pending.neutral);
    }
  }

  cancelAll(): void {
    this.credentialBroker.clearAll();
    for (const pending of [...this.pending.values()]) pending.resolve(pending.neutral);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.activeGeneration = undefined;
  }

  private releasePending(requestId: string): PendingDialog | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    return pending;
  }

  private clear(requestId: string): void {
    const pending = this.releasePending(requestId);
    if (pending) this.publishClosed(pending.request);
  }
}

class GenerationUiContext implements ExtensionUIContext {
  constructor(
    private readonly bridge: RemoteUiBridge,
    private readonly sessionId: string,
    private readonly generation: number,
  ) {}

  requestStateQLCredential(request: StateQLCredentialRequest): Promise<string | undefined> {
    return this.bridge.requestStateQLCredential(this.sessionId, this.generation, request);
  }

  requestStateQLPassword(request: StateQLCredentialRequest, target: StateQLPasswordTarget): Promise<string | undefined> {
    return this.bridge.requestStateQLPassword(this.sessionId, this.generation, request, target);
  }

  invalidateStateQLPassword(request: StateQLCredentialRequest, target: StateQLPasswordTarget): void {
    this.bridge.invalidateStateQLPassword(this.sessionId, this.generation, request, target);
  }

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

  questionnaire(
    questions: QuestionnaireQuestion[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string[] | undefined> {
    const offered = questions.slice(0, 6).map((item) => ({
      question: bounded(item.question, 500),
      options: item.options.slice(0, 5).map((option) => bounded(option, 500)),
    }));
    if (!offered.length || offered.some((item) => item.options.length < 2)) {
      return Promise.resolve(undefined);
    }
    return this.bridge.dialog({
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      method: "questionnaire",
      payload: { questions: offered },
      neutral: undefined,
      questions: offered,
      dialogOptions: opts,
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
