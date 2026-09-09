import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BatchCommand, CredentialRequest, Response, StateQLSnapshot } from "@fadhilp/stateql";
import type { StateQLPanelCommand } from "./stateql-command.ts";

export type ConnectionSetupInput = Extract<StateQLPanelCommand, { command: "connection.setup" }>;
export interface SetupPasswordTarget {
  driver: "postgres" | "mysql" | "mongodb" | "redis";
  username: string;
  hostname: string;
  port: number;
  database: string;
}
export interface SetupPasswordOptions {
  timeoutMs: number;
  forcePrompt?: boolean;
  savedPassword?: { reference: string; target: string };
  initialPassword?: string;
  remember?: { reference: string; target: string };
}
export interface SetupUi {
  confirm(title: string, message: string, options?: { timeout: number; signal?: AbortSignal }): Promise<boolean>;
  requestStateQLCredential(request: CredentialRequest): Promise<string | undefined>;
  requestStateQLPassword?(
    request: CredentialRequest,
    target: SetupPasswordTarget,
    options?: SetupPasswordOptions,
  ): Promise<string | undefined>;
  rememberStateQLPassword?(reference: string, target: string, password: string, signal?: AbortSignal): Promise<boolean>;
  invalidateStateQLPassword?(request: CredentialRequest, target: SetupPasswordTarget): void;
  invalidateStateQLCredential?(request: CredentialRequest): void;
  forgetStateQLCredential?(reference: string): Promise<boolean>;
  setStatus?(key: string, text: string | undefined): void;
}
interface SetupDependencies {
  snapshot(): StateQLSnapshot;
  execute(command: BatchCommand): Promise<Response<unknown>>;
  /** Secret is scoped to this one adapter call, not retained in an input, profile or event. */
  connect(
    command: BatchCommand,
    reference: string | undefined,
    password: string | undefined,
  ): Promise<Response<unknown>>;
  ui: SetupUi;
  actorId: string;
  operationId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  checkConnection(): void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const POSTGRES_CA_PRESET_PARAMETER = "pylon_tls_ca";
export const AWS_RDS_CA_PRESET = "aws-rds";
const AWS_RDS_CA_FILE = fileURLToPath(new URL("../assets/global-bundle.pem", import.meta.url));

/** Replace Pylon's portable CA preset with the installed, connection-scoped trust bundle path. */
export function materializeConnectionTarget(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return source;
  }
  const presetEntries = [...url.searchParams.entries()].filter(
    ([key]) => key.toLowerCase() === POSTGRES_CA_PRESET_PARAMETER,
  );
  if (!presetEntries.length) return source;
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    presetEntries.length !== 1 ||
    presetEntries[0]?.[0] !== POSTGRES_CA_PRESET_PARAMETER ||
    presetEntries[0]?.[1] !== AWS_RDS_CA_PRESET
  )
    throw new Error("Unsupported PostgreSQL CA preset.");
  const parameters = [...url.searchParams.entries()];
  const sslModes = parameters.filter(([key]) => key.toLowerCase() === "sslmode");
  if (
    parameters.some(([key]) =>
      ["sslrootcert", "ssl", "rejectunauthorized", "uselibpqcompat", "sslnegotiation"].includes(
        key.toLowerCase(),
      ),
    ) ||
    sslModes.length > 1 ||
    sslModes.some(([key, value]) => key !== "sslmode" || value !== "verify-full")
  )
    throw new Error("The AWS RDS CA preset cannot be combined with custom or conflicting TLS options.");
  for (const key of [...url.searchParams.keys()])
    if (key.toLowerCase() === POSTGRES_CA_PRESET_PARAMETER || key.toLowerCase() === "sslmode")
      url.searchParams.delete(key);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", AWS_RDS_CA_FILE);
  return url.toString();
}

/** Resolve legacy URL credentials once. Only its password may accompany an explicit configuration. */
export function setupTarget(source: string): {
  target: string;
  password?: string;
  prompt?: SetupPasswordTarget;
  summary: string;
} {
  if (source.startsWith("sqlite:")) return { target: source, summary: `SQLite file: ${source.slice(7)}` };
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Invalid database connection settings.");
  }
  const driver =
    url.protocol === "postgres:" || url.protocol === "postgresql:"
      ? "postgres"
      : url.protocol === "mysql:"
        ? "mysql"
        : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
          ? "mongodb"
          : url.protocol === "redis:" || url.protocol === "rediss:"
            ? "redis"
            : undefined;
  if (!driver || !url.hostname || url.hash) throw new Error("Unsupported database connection settings.");
  for (const key of url.searchParams.keys())
    if (
      ["user", "username", "password", "pwd", "host", "hostaddr", "port", "database", "dbname"].includes(
        key.toLowerCase(),
      )
    )
      throw new Error("Put the database destination and username in the connection fields, not URL query options.");
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  url.password = "";
  const username = decodeURIComponent(url.username) || (driver === "redis" ? "default" : "");
  const prompt: SetupPasswordTarget | undefined = username
    ? {
        driver,
        username,
        hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
        port: Number(
          url.port || (driver === "postgres" ? 5432 : driver === "mysql" ? 3306 : driver === "redis" ? 6379 : 27017),
        ),
        database: url.pathname.replace(/^\//u, ""),
      }
    : undefined;
  const sslmode = url.searchParams.getAll("sslmode").at(-1);
  const tls =
    driver === "postgres"
      ? sslmode === "disable"
        ? "disabled (unencrypted)"
        : sslmode === "verify-full"
          ? "required, certificate and hostname verified"
          : `driver settings (${sslmode ?? "server default; may be unencrypted"})`
      : url.protocol;
  const caPreset = url.searchParams.getAll(POSTGRES_CA_PRESET_PARAMETER).at(-1);
  const ca =
    driver === "postgres"
      ? `\nCA: ${caPreset === AWS_RDS_CA_PRESET ? "packaged AWS RDS global trust bundle" : url.searchParams.getAll("sslrootcert").at(-1) || "server default trust store"}`
      : "";
  const warning = insecureTls(source)
    ? "\nWarning: this target weakens or disables TLS certificate or hostname verification."
    : "";
  return {
    target: url.toString(),
    password,
    prompt,
    summary: `${driver}: ${username || "default user"}@${url.hostname}:${prompt?.port ?? url.port}${url.pathname}\nTLS: ${tls}${ca}${warning}`,
  };
}

export function insecureTls(target: string | undefined): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const sslMode = url.searchParams.getAll("sslmode").at(-1)?.toLowerCase();
    const libpqCompat = url.searchParams.getAll("uselibpqcompat").at(-1)?.toLowerCase() === "true";
    return (
      sslMode === "disable" ||
      sslMode === "no-verify" ||
      (libpqCompat && (sslMode === undefined || ["prefer", "require", "verify-ca"].includes(sslMode))) ||
      url.searchParams.get("ssl")?.toLowerCase() === "false" ||
      url.searchParams.get("rejectUnauthorized")?.toLowerCase() === "false"
    );
  } catch {
    return false;
  }
}

function failureMessage(cause: unknown, password?: string): string {
  let message = cause instanceof Error ? cause.message : "Database setup failed.";
  if (password)
    for (const secret of [password, encodeURIComponent(password)]) message = message.split(secret).join("[redacted]");
  return message.replace(/(\w+:\/\/[^\s/:@]*:)[^\s@]+@/gu, "$1[redacted]@").slice(0, 2000);
}
function failureKind(message: string): string {
  if (/certificate|self.signed|unable to verify/iu.test(message)) return "TLS_TRUST_FAILED";
  if (/no encryption|requires? (?:SSL|TLS)/iu.test(message)) return "TLS_REQUIRED";
  if (
    /password authentication failed|invalid password|authentication failed|access denied for user|WRONGPASS/iu.test(
      message,
    )
  )
    return "AUTHENTICATION_FAILED";
  if (/ECONN|ENOTFOUND|ETIMEDOUT|timeout|timed out|network/iu.test(message)) return "NETWORK_FAILED";
  if (/cancel|abort/iu.test(message)) return "CANCELLED";
  return "CONFIGURATION_FAILED";
}

/** One exclusive, immutable setup attempt. No profile is saved before a successful requested connection. */
export async function runConnectionSetup(
  input: ConnectionSetupInput,
  deps: SetupDependencies,
): Promise<Response<unknown> | { declined: true }> {
  const { ui, signal } = deps;
  const started = Date.now();
  const snapshot = deps.snapshot();
  const envelope = { command_id: `setup_${randomUUID()}`, session_id: snapshot.session.session_id };
  const statusKey = `database-setup:${deps.operationId}`;
  let connected = false;
  let saved = false;
  let password: string | undefined;
  let prompt: SetupPasswordTarget | undefined;
  let credentialRequest: CredentialRequest | undefined;
  let newReference: string | undefined;
  let response: Response<unknown> | undefined;
  const active = () => {
    if (signal?.aborted) throw new Error("Database setup cancelled.");
    deps.checkConnection();
  };
  const execute = (command: BatchCommand) => deps.execute(command);
  const showProfile = async (name: string) => {
    const shown = await execute({ command: "profile.show", name });
    if (!shown.ok || !record(shown.data))
      throw new Error("The selected saved profile is unavailable. Review its settings.");
    return shown.data;
  };
  try {
    active();
    ui.setStatus?.(statusKey, "resolving");
    const existing = input.update && input.name ? await showProfile(input.name) : undefined;
    const profile = input.profile
      ? existing && input.profile === input.name
        ? existing
        : await showProfile(input.profile)
      : undefined;
    let source = input.target ?? (typeof profile?.target === "string" ? profile.target : undefined);
    const environment = input.secret_env ?? (typeof profile?.secret_env === "string" ? profile.secret_env : undefined);
    const legacyReference = typeof profile?.credential_ref === "string" ? profile.credential_ref : undefined;
    const readOnly = input.read_only ?? (typeof profile?.read_only === "boolean" ? profile.read_only : true);
    const transientReference = `PYLON_STATEQL_BROKERED_${randomUUID().replaceAll("-", "")}`;
    const request = (
      reference: string,
      source: "secret_env" | "credential_ref" | "password_ref",
      target?: string,
    ): CredentialRequest =>
      ({
        reference,
        source,
        ...(target ? { target } : {}),
        actorId: deps.actorId,
        session: { id: snapshot.session.session_id, name: snapshot.session.name },
        operation: "connect",
        access: readOnly ? "read" : "write",
        requestedReadOnly: readOnly,
        signal,
      }) as CredentialRequest;
    if (environment)
      source = process.env[environment] ?? (await ui.requestStateQLCredential(request(environment, "secret_env")));
    else if (legacyReference) source = await ui.requestStateQLCredential(request(legacyReference, "credential_ref"));
    if (source === undefined) return { declined: true };
    const resolved = setupTarget(source);
    // Only a selected legacy source can carry a password. Browser targets must never do so.
    if (input.target && resolved.password !== undefined)
      throw new Error("Enter the password in the password field, not the target URL.");
    password = resolved.password;
    source = resolved.target;
    const connectionTarget = materializeConnectionTarget(source);
    prompt = resolved.prompt;
    const storedProfile = existing ?? profile;
    const storedReference =
      typeof storedProfile?.password_ref === "string"
        ? storedProfile.password_ref
        : typeof storedProfile?.credential_ref === "string"
          ? storedProfile.credential_ref
          : undefined;
    const authority = input.target
      ? "Submitted connection settings"
      : environment
        ? `Environment variable ${environment}`
        : `Saved profile ${input.profile}`;
    active();
    ui.setStatus?.(statusKey, "approving");
    const action =
      input.action === "save"
        ? "Save these settings without testing the connection"
        : input.action === "save-connect"
          ? "Connect, then save these settings"
          : "Connect using these settings";
    if (
      !(await ui.confirm(
        "Review database connection",
        `${action}?\n${authority}\n${resolved.summary}\nAccess: ${readOnly ? "read-only" : "read-write"}. Database content may be sent to the selected model provider.`,
        { timeout: deps.timeoutMs, signal },
      ))
    )
      return { declined: true };
    active();
    if (prompt && (input.action !== "save" || input.remember)) {
      if (!ui.requestStateQLPassword) throw new Error("Secure password entry is unavailable.");
      credentialRequest = request(storedReference ?? transientReference, "password_ref", connectionTarget);
      password = await ui.requestStateQLPassword(credentialRequest, prompt, {
        timeoutMs: deps.timeoutMs,
        forcePrompt: input.password_provided === true,
        ...(storedReference ? { savedPassword: { reference: storedReference, target: connectionTarget } } : {}),
        ...(password !== undefined ? { initialPassword: password } : {}),
      });
      if (password === undefined) return { declined: true };
    } else if (!prompt && (input.password_provided || input.remember)) {
      if (!source.startsWith("sqlite:"))
        throw new Error("Enter a username before supplying or remembering a password.");
    }
    active();
    if (input.action !== "save") {
      ui.setStatus?.(statusKey, "connecting");
      response = await deps.connect(
        {
          command: "connect",
          target: connectionTarget,
          ...(password !== undefined ? { password_ref: transientReference } : {}),
          ...(input.name ? { name: input.name } : {}),
          read_only: readOnly,
          ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
        } as BatchCommand,
        password === undefined ? undefined : transientReference,
        password,
      );
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      connected = true;
    }
    if (input.action !== "connect") {
      if (signal?.aborted) throw new Error("Connection completed, but saving was cancelled.");
      ui.setStatus?.(statusKey, "saving");
      if (input.target && input.remember && password !== undefined) {
        newReference = `pylon:stateql:v1:${randomUUID()}`;
        if (!(await ui.rememberStateQLPassword?.(newReference, connectionTarget, password, signal)))
          throw new Error("The password could not be saved in the OS vault. Settings were not saved.");
      }
      if (signal?.aborted) throw new Error("Saving was cancelled.");
      const persistedSource =
        input.profile && profile
          ? Object.fromEntries(
              ["target", "secret_env", "credential_ref", "password_ref"]
                .filter(key => typeof profile[key] === "string")
                .map(key => [key, profile[key]]),
            )
          : input.secret_env
            ? { secret_env: input.secret_env }
            : {
                target: source,
                ...(newReference ? { password_ref: newReference } : input.update ? { password_ref: null } : {}),
              };
      const written = await execute({
        command: input.update ? "profile.update" : "profile.add",
        name: input.name!,
        ...persistedSource,
        read_only: readOnly,
      } as BatchCommand);
      if (!written.ok) throw new Error(`Settings could not be saved: ${written.error.message}`);
      saved = true;
      response ??= written;
    }
    return {
      ...(response?.ok ? response : envelope),
      ok: true,
      data: { setup: { connected, saved, stage: "complete" } },
      warnings: response?.ok ? response.warnings : [],
      meta: { duration_ms: Date.now() - started },
    } as Response<unknown>;
  } catch (cause) {
    const message = failureMessage(cause, password);
    const code = failureKind(message);
    if (credentialRequest && prompt && (code === "AUTHENTICATION_FAILED" || signal?.aborted)) {
      ui.invalidateStateQLPassword?.(credentialRequest, prompt);
      if (code === "AUTHENTICATION_FAILED") ui.invalidateStateQLCredential?.(credentialRequest);
    }
    if (connected)
      return {
        ...envelope,
        ok: true,
        data: {
          setup: {
            connected: true,
            saved: false,
            stage: "saving",
            error: { message: `Connected, but saving failed. ${message}` },
          },
        },
        warnings: [{ code: "SETUP_SAVE_FAILED", message }],
        meta: { duration_ms: Date.now() - started },
      } as Response<unknown>;
    return {
      ...envelope,
      ok: false,
      error: {
        code,
        message,
        retryable: code === "NETWORK_FAILED",
        executed: false,
        suggested_action:
          code === "TLS_TRUST_FAILED"
            ? "Select verified TLS and a trusted server-side CA bundle; do not disable verification."
            : "Review the effective connection settings and retry.",
      },
      meta: { duration_ms: Date.now() - started },
    } as Response<unknown>;
  } finally {
    password = undefined;
    if (newReference && !saved) await ui.forgetStateQLCredential?.(newReference).catch(() => false);
    ui.setStatus?.(statusKey, undefined);
  }
}
