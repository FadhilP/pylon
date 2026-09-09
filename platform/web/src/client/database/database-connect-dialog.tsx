import { useEffect, useRef, useState } from "react";
import type { StateQLCommandInput } from "../../shared/protocol/snapshots";
import type { DatabaseDriver } from "./database-workspace";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { UiDialog } from "../runtime/remote-ui-dialog";
import { databasePasswordSubmission } from "./database-password-submission";
import {
  DatabaseSetupError,
  postgresTlsTarget,
  type DatabaseSetupAction,
  type DatabaseSetupStep,
  type PostgresTlsMode,
} from "./database-setup";

export interface DatabaseProfileSetup {
  name: string;
  target?: string;
  secretEnv?: string;
  readOnly?: boolean;
  hasCredential?: boolean;
}

type Source = "target" | "environment" | "saved";
type PostgresCaSource = "system" | "aws-rds" | "custom";
type DatabaseSetupInput = Extract<StateQLCommandInput, { command: "connection.setup" }>;

function targetFields(target: string | undefined) {
  if (!target) return {};
  if (target.startsWith("sqlite:")) return { driver: "sqlite" as const, file: target.slice("sqlite:".length) };
  try {
    const url = new URL(target);
    const driver: DatabaseDriver | undefined =
      url.protocol === "postgres:" || url.protocol === "postgresql:"
        ? "postgres"
        : url.protocol === "mysql:"
          ? "mysql"
          : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
            ? "mongodb"
            : url.protocol === "redis:" || url.protocol === "rediss:"
              ? "redis"
              : undefined;
    if (!driver) return {};
    return {
      driver,
      host: url.hostname,
      port:
        url.port ||
        (driver === "postgres" ? "5432" : driver === "mysql" ? "3306" : driver === "redis" ? "6379" : "27017"),
      database: decodeURIComponent(url.pathname.replace(/^\//u, "")),
      username: decodeURIComponent(url.username),
      caFile: url.searchParams.getAll("sslrootcert").at(-1) ?? "",
    };
  } catch {
    return {};
  }
}

function savedPostgresTlsMode(target: string | undefined): PostgresTlsMode {
  if (!target) return "verify-full";
  try {
    const url = new URL(target);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return "verify-full";
    const mode = url.searchParams.getAll("sslmode").at(-1)?.toLowerCase();
    if (mode !== undefined) return mode === "disable" ? "disable" : "verify-full";
    const ssl = url.searchParams.getAll("ssl").at(-1)?.toLowerCase();
    return ssl === "0" || ssl === "false" ? "disable" : "verify-full";
  } catch {
    return "verify-full";
  }
}

function savedPostgresCaSource(target: string | undefined): PostgresCaSource {
  if (!target) return "system";
  try {
    const url = new URL(target);
    if (url.searchParams.get("pylon_tls_ca") === "aws-rds") return "aws-rds";
    return url.searchParams.has("sslrootcert") ? "custom" : "system";
  } catch {
    return "system";
  }
}

export function DatabaseConnectDialog({
  profile,
  pending,
  suspended,
  generation,
  step,
  onClose,
  onSubmit,
  onRemove,
}: {
  profile?: DatabaseProfileSetup;
  pending?: RuntimeStoreSnapshot["pendingUi"];
  suspended?: boolean;
  generation: number;
  step?: DatabaseSetupStep;
  onClose: () => void;
  onSubmit: (input: StateQLCommandInput, operationId: string) => Promise<void>;
  onRemove?: (forgetCredential: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = targetFields(profile?.target);
  const [source, setSource] = useState<Source>(
    profile
      ? profile.secretEnv
        ? "environment"
        : profile.target
          ? "target"
          : profile.hasCredential
            ? "saved"
            : "target"
      : "target",
  );
  const [driver, setDriver] = useState<DatabaseDriver>(initial.driver ?? "postgres");
  const [tls, setTls] = useState<PostgresTlsMode>(savedPostgresTlsMode(profile?.target));
  const [caSource, setCaSource] = useState<PostgresCaSource>(savedPostgresCaSource(profile?.target));
  const [caFile, setCaFile] = useState(initial.caFile ?? "");
  const caFileDirty = useRef(false);
  const [name, setName] = useState(profile?.name ?? "");
  const [host, setHost] = useState(initial.host ?? "localhost");
  const [port, setPort] = useState(initial.port ?? "5432");
  const [database, setDatabase] = useState(initial.database ?? "");
  const [username, setUsername] = useState(initial.username ?? "");
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const passwordAttempt = useRef<ReturnType<typeof databasePasswordSubmission> | undefined>(undefined);
  const [file, setFile] = useState(initial.file ?? "");
  const [environment, setEnvironment] = useState(profile?.secretEnv ?? "");
  const [readOnly, setReadOnly] = useState(profile?.readOnly !== false);
  const [remember, setRemember] = useState(Boolean(profile?.hasCredential));
  const [phase, setPhase] = useState<"editing" | "working" | "error">("editing");
  const [removing, setRemoving] = useState(false);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const profileName = profile?.name;
  const [retry, setRetry] = useState<{ input: DatabaseSetupInput; action: DatabaseSetupAction }>();
  const [forget, setForget] = useState(false);
  const [error, setError] = useState("");
  const targetDirty = useRef(false);
  const locked = phase === "working" || Boolean(pending);
  const inlinePassword = Boolean(pending && passwordAttempt.current?.matches(pending));
  const prompt = pending && !inlinePassword ? pending : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPassword("");
    setPasswordTouched(false);
    return () => passwordAttempt.current?.clear();
  }, [generation, source, driver]);
  useEffect(() => {
    if (suspended || (pending && !pending.owned)) {
      passwordAttempt.current?.clear();
      setPassword("");
      return;
    }
    if (!pending) return;
    let active = true;
    const attempt = passwordAttempt.current;
    void attempt
      ?.answer(pending, (request, body) => runtimeStore.answerUi(request, body))
      .catch(() => {
        attempt.clear();
        if (active) setError("The password response was rejected. Cancel setup and try again.");
      });
    return () => {
      active = false;
    };
  }, [pending, suspended, generation]);

  useEffect(() => {
    const previous = document.activeElement;
    if (suspended) dialog.current?.close();
    else if (!dialog.current?.open) dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [suspended]);
  useEffect(() => {
    if (!prompt && !suspended && dialog.current?.open)
      dialog.current
        .querySelector<HTMLElement>(
          phase === "editing" ? "form input:not(:disabled), form button:not(:disabled)" : "[data-setup-status]",
        )
        ?.focus();
  }, [Boolean(prompt), suspended, phase]);

  const changedTarget = () => {
    targetDirty.current = true;
  };
  const applyPostgresTls = (value: string) => {
    if (tls !== "disable" && caFileDirty.current && caSource === "custom" && !caFile.trim())
      throw new Error("Enter the server path to a custom CA certificate bundle.");
    return postgresTlsTarget(
      value,
      tls,
      caFileDirty.current ? (caSource === "custom" ? caFile : "") : undefined,
      caFileDirty.current && caSource === "aws-rds" ? "aws-rds" : undefined,
    );
  };
  const target = () => {
    if (profile?.target && !targetDirty.current) return applyPostgresTls(profile.target);
    if (driver === "sqlite") {
      if (!file.trim()) throw new Error("Enter a database file path on the Pylon server.");
      return file.trim().startsWith("sqlite:") ? file.trim() : `sqlite:${file.trim()}`;
    }
    if (
      !host.trim() ||
      (driver !== "redis" && !database.trim()) ||
      !Number.isInteger(Number(port)) ||
      Number(port) < 1 ||
      Number(port) > 65535
    )
      throw new Error("Enter a host, database, and valid port.");
    if (driver === "redis" && database && !/^\d+$/.test(database))
      throw new Error("Redis database must be a nonnegative index.");
    // Preserve secure/SRV transport when editing an existing profile.
    const protocol =
      profile?.target?.startsWith("rediss:") && driver === "redis"
        ? "rediss"
        : profile?.target?.startsWith("mongodb+srv:") && driver === "mongodb"
          ? "mongodb+srv"
          : driver;
    const options =
      profile?.target && targetFields(profile.target).driver === driver ? new URL(profile.target).search : "";
    const value = `${protocol}://${username ? `${encodeURIComponent(username)}@` : ""}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${protocol === "mongodb+srv" ? "" : `:${port}`}/${encodeURIComponent(database || (driver === "redis" ? "0" : ""))}${options}`;
    return applyPostgresTls(value);
  };
  const inputFor = (action: DatabaseSetupAction, passwordProvided: boolean): DatabaseSetupInput => {
    if (source === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environment.trim()))
      throw new Error("Enter a valid environment variable name.");
    const name = profileName ?? nameValue();
    if ((action === "save" || action === "save-connect") && !name) throw new Error("Give the saved connection a name.");
    const connectionSource =
      source === "environment"
        ? { secret_env: environment.trim() }
        : source === "saved"
          ? profileName
            ? { profile: profileName }
            : (() => {
                throw new Error("Select a connection target or environment variable.");
              })()
          : { target: target() };
    return {
      command: "connection.setup",
      action,
      ...connectionSource,
      ...(name ? { name } : {}),
      ...(profileName ? { update: true } : {}),
      read_only: readOnly,
      ...(source === "target" && action !== "connect" ? { remember } : {}),
      ...(passwordProvided ? { password_provided: true } : {}),
    };
  };
  const nameValue = () => name.trim();
  const submit = async (
    action: DatabaseSetupAction,
    previous?: { input: DatabaseSetupInput; action: DatabaseSetupAction },
  ) => {
    if (locked || actionLock.current) return;
    actionLock.current = true;
    setRetry(undefined);
    setRemoving(false);
    let started = false;
    let frozen: DatabaseSetupInput | undefined;
    try {
      const passwordProvided = !previous && source === "target" && driver !== "sqlite" && passwordTouched;
      const input = previous
        ? { ...previous.input, action: previous.action, password_provided: false }
        : inputFor(action, passwordProvided);
      frozen = { ...input, password_provided: false };
      const operationId = crypto.randomUUID();
      passwordAttempt.current?.clear();
      if (passwordProvided) {
        if (password && !username && driver !== "redis")
          throw new Error("Enter a username to use a database password.");
        if (input.target)
          passwordAttempt.current = databasePasswordSubmission(password, {
            target: input.target,
            operationId,
            generation,
            readOnly,
          });
      }
      setPassword("");
      setPasswordTouched(false);
      setPhase("working");
      setError("");
      started = true;
      await onSubmit(input, operationId);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "Invalid connection setup");
      if (cause instanceof DatabaseSetupError) {
        const retryAction = cause.connected ? "save" : action === "save-connect" ? "save-connect" : "connect";
        if (frozen && (cause.connected || action !== "save"))
          setRetry({ input: previous?.input ?? frozen, action: retryAction });
      }
      if (started) setPhase("error");
    } finally {
      actionLock.current = false;
      passwordAttempt.current?.clear();
    }
  };
  const remove = async () => {
    if (!onRemove || locked || actionLock.current) return;
    actionLock.current = true;
    setRetry(undefined);
    try {
      setPassword("");
      setPhase("working");
      setError("");
      setRemoving(true);
      await onRemove(forget);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "Could not remove saved connection");
      setPhase("error");
    } finally {
      actionLock.current = false;
    }
  };

  return (
    <dialog
      ref={dialog}
      className="database-connect"
      role={prompt?.method === "confirm" ? "alertdialog" : undefined}
      aria-describedby={prompt?.owned ? `ui-description-${prompt.requestId}` : undefined}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={
        prompt
          ? `ui-title-${prompt.requestId}`
          : phase === "editing"
            ? "database-connect-title"
            : "database-setup-title"
      }>
      <form
        hidden={phase !== "editing" || Boolean(prompt)}
        onSubmit={event => {
          event.preventDefault();
          void submit(profileName ? "save-connect" : "connect");
        }}>
        <header>
          <strong id="database-connect-title">{profileName ? `Set up ${profileName}` : "Connect to a database"}</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close connection dialog">
            ×
          </button>
        </header>
        <div className="database-connect-fields">
          {profile ? (
            <label>
              Name
              <input value={profile.name} disabled />
            </label>
          ) : (
            <label>
              Source
              <select value={source} disabled={locked} onChange={event => setSource(event.target.value as Source)}>
                <option value="target">New connection</option>
                <option value="environment">Environment variable</option>
              </select>
            </label>
          )}
          {!profile && (
            <label>
              Name
              <input
                value={name}
                maxLength={200}
                disabled={locked}
                onChange={event => setName(event.target.value)}
                placeholder="Optional connection name"
              />
            </label>
          )}
          {profile && (
            <label>
              Source
              <select value={source} disabled={locked} onChange={event => setSource(event.target.value as Source)}>
                {profile.hasCredential && <option value="saved">Keep saved credential</option>}
                <option value="target">Replace with connection target</option>
                <option value="environment">Replace with environment variable</option>
              </select>
            </label>
          )}
          {source === "saved" ? (
            <p className="database-muted">
              This saved profile is managed on the Pylon server. Its settings and OS-vault credential are controlled
              externally and are not sent from hidden form fields.
            </p>
          ) : source === "environment" ? (
            <label>
              Environment variable
              <input
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                value={environment}
                disabled={locked}
                onChange={event => setEnvironment(event.target.value)}
                placeholder="DATABASE_URL"
              />
              <small>The variable and its connection settings are controlled on the Pylon server.</small>
            </label>
          ) : (
            <>
              <label>
                Driver
                <select
                  value={driver}
                  disabled={locked}
                  onChange={event => {
                    const next = event.target.value as DatabaseDriver;
                    changedTarget();
                    setDriver(next);
                    setPort(
                      next === "postgres" ? "5432" : next === "mysql" ? "3306" : next === "redis" ? "6379" : "27017",
                    );
                  }}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="mongodb">MongoDB</option>
                  <option value="redis">Redis</option>
                  <option value="sqlite">SQLite</option>
                </select>
              </label>
              {driver === "postgres" && (
                <label>
                  TLS / encryption
                  <select
                    value={tls}
                    disabled={locked}
                    onChange={event => setTls(event.target.value as PostgresTlsMode)}>
                    <option value="verify-full">Require TLS and verify certificate</option>
                    <option value="disable">Disabled (unencrypted)</option>
                  </select>
                  <small>
                    {tls === "disable"
                      ? "Traffic will not be encrypted. Use only for a trusted local connection."
                      : "Verifies the server certificate and hostname. No fallback to an unencrypted connection."}
                  </small>
                </label>
              )}
              {driver === "postgres" && (
                <>
                  <label>
                    Certificate authority
                    <select
                      value={caSource}
                      disabled={locked || tls === "disable"}
                      onChange={event => {
                        caFileDirty.current = true;
                        setCaSource(event.target.value as PostgresCaSource);
                        setTls("verify-full");
                      }}>
                      <option value="system">Server default trust store</option>
                      <option value="aws-rds">AWS RDS global trust bundle</option>
                      <option value="custom">Custom CA file</option>
                    </select>
                    <small>
                      {caSource === "aws-rds"
                        ? "Uses Pylon's packaged official AWS RDS bundle with certificate and hostname verification."
                        : caSource === "custom"
                          ? "Uses a PEM CA bundle readable by the Pylon server process."
                          : "Uses the certificate authorities trusted by the Pylon server runtime."}
                    </small>
                  </label>
                  {caSource === "custom" && (
                    <label>
                      CA certificate file (on server)
                      <input
                        value={caFile}
                        disabled={locked || tls === "disable"}
                        autoComplete="off"
                        maxLength={4096}
                        placeholder="Server path to a PEM CA bundle"
                        onChange={event => {
                          caFileDirty.current = true;
                          setCaFile(event.target.value);
                          setTls("verify-full");
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              {driver === "sqlite" ? (
                <label>
                  Database file
                  <input
                    required
                    value={file}
                    disabled={locked}
                    onChange={event => {
                      changedTarget();
                      setFile(event.target.value);
                    }}
                    placeholder="Server filesystem path"
                  />
                </label>
              ) : (
                <>
                  <div className="database-connect-pair">
                    <label>
                      Host
                      <input
                        required
                        value={host}
                        disabled={locked}
                        onChange={event => {
                          changedTarget();
                          setHost(event.target.value);
                        }}
                      />
                    </label>
                    <label>
                      Port
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        required
                        value={port}
                        disabled={locked}
                        onChange={event => {
                          changedTarget();
                          setPort(event.target.value);
                        }}
                      />
                    </label>
                  </div>
                  <label>
                    Database
                    <input
                      required
                      value={database}
                      disabled={locked}
                      onChange={event => {
                        changedTarget();
                        setDatabase(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Username
                    <input
                      autoComplete="off"
                      value={username}
                      disabled={locked}
                      onChange={event => {
                        changedTarget();
                        setUsername(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      maxLength={4096}
                      disabled={locked}
                      onChange={event => {
                        setPasswordTouched(true);
                        setPassword(event.target.value);
                      }}
                    />
                  </label>
                  <p className="database-muted">
                    Connecting permits {readOnly ? "read-only" : "read-write"} access to this destination. Database
                    content may be sent to the selected model provider. Passwords stay in server memory for up to one
                    hour, never in queries or model history. Save stores settings only unless you choose to remember
                    credentials.
                  </p>
                  <label className="database-check">
                    <input
                      type="checkbox"
                      checked={remember}
                      disabled={locked}
                      onChange={event => setRemember(event.target.checked)}
                    />{" "}
                    Remember password in the OS vault when saving
                  </label>
                </>
              )}
            </>
          )}
          <label className="database-check">
            <input
              type="checkbox"
              checked={readOnly}
              disabled={locked}
              onChange={event => setReadOnly(event.target.checked)}
            />{" "}
            Read-only connection
          </label>
          {error && (
            <p role="alert" className="database-notice">
              {error}
            </p>
          )}
          {profile && onRemove && (
            <div className="database-connect-remove">
              <label className="database-check">
                <input
                  type="checkbox"
                  checked={forget}
                  disabled={locked}
                  onChange={event => setForget(event.target.checked)}
                />{" "}
                Forget credential when removing
              </label>
              <button type="button" className="secondary-button danger" disabled={locked} onClick={() => void remove()}>
                Remove saved connection
              </button>
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="secondary-button" disabled={locked} onClick={() => void submit("save")}>
            Save
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={locked}
            onClick={() => void submit("save-connect")}>
            Save &amp; connect
          </button>
          {!profileName && (
            <button className="primary-button" type="submit" disabled={locked}>
              Connect
            </button>
          )}
        </footer>
      </form>
      {prompt && (
        <div className="database-setup-prompt">
          <UiDialog key={prompt.requestId} request={prompt} embedded presentation="database" />
          {(!prompt.owned || prompt.method !== "confirm") && (
            <footer>
              <button type="button" className="secondary-button" onClick={onClose}>
                Cancel setup
              </button>
            </footer>
          )}
        </div>
      )}
      {!prompt && phase !== "editing" && (
        <section
          className="database-setup-status"
          data-setup-status
          tabIndex={-1}
          aria-labelledby="database-setup-title">
          <header>
            <strong id="database-setup-title">
              {phase === "error"
                ? "Setup did not complete"
                : removing
                  ? "Removing saved connection…"
                  : step === "resolving"
                    ? "Resolving connection settings…"
                    : step === "approving"
                      ? "Awaiting approval…"
                      : step === "saving"
                        ? "Saving connection…"
                        : "Connecting to database…"}
            </strong>
          </header>
          <div>
            <p role={error ? "alert" : "status"}>
              {error || "Keep this dialog open while the operation completes. Any required approval will appear here."}
            </p>
          </div>
          <footer>
            {phase === "error" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setError("");
                  setPassword("");
                  setPasswordTouched(false);
                  setPhase("editing");
                }}>
                Edit connection
              </button>
            )}
            {phase === "error" && retry && (
              <button type="button" className="primary-button" onClick={() => void submit(retry.action, retry)}>
                {retry.action === "save" ? "Retry saving" : "Retry connection"}
              </button>
            )}
            <button type="button" className="secondary-button" onClick={onClose}>
              {phase === "error" ? "Close" : "Cancel setup"}
            </button>
          </footer>
        </section>
      )}
    </dialog>
  );
}
