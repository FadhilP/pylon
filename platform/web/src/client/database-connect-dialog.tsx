import { useEffect, useRef, useState } from "react";
import type { StateQLCommandInput } from "../shared/protocol/snapshots";
import type { DatabaseDriver } from "../shared/database-workspace";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";
import { UiDialog } from "./ui-dialog";

export interface DatabaseProfileSetup {
  name: string;
  target?: string;
  secretEnv?: string;
  readOnly?: boolean;
  hasCredential?: boolean;
}

type Source = "target" | "environment" | "saved";
type SetupAction = "connect" | "save" | "save-connect";

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
    };
  } catch {
    return {};
  }
}

export function DatabaseConnectDialog({
  profile,
  pending,
  suspended,
  onClose,
  onSubmit,
  onRemove,
}: {
  profile?: DatabaseProfileSetup;
  pending?: RuntimeStoreSnapshot["pendingUi"];
  suspended?: boolean;
  onClose: () => void;
  onSubmit: (input: StateQLCommandInput, action: SetupAction) => Promise<void>;
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
  const [name, setName] = useState(profile?.name ?? "");
  const [host, setHost] = useState(initial.host ?? "localhost");
  const [port, setPort] = useState(initial.port ?? "5432");
  const [database, setDatabase] = useState(initial.database ?? "");
  const [username, setUsername] = useState(initial.username ?? "");
  const [file, setFile] = useState(initial.file ?? "");
  const [environment, setEnvironment] = useState(profile?.secretEnv ?? "");
  const [readOnly, setReadOnly] = useState(profile?.readOnly !== false);
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [forget, setForget] = useState(false);
  const [error, setError] = useState("");
  const targetDirty = useRef(false);
  const locked = submitting || Boolean(pending);

  useEffect(() => {
    const previous = document.activeElement;
    if (suspended) dialog.current?.close();
    else if (!dialog.current?.open) dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [suspended]);

  const changedTarget = () => {
    targetDirty.current = true;
  };
  const target = () => {
    if (profile?.target && !targetDirty.current) return profile.target;
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
    return `${protocol}://${username ? `${encodeURIComponent(username)}@` : ""}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${protocol === "mongodb+srv" ? "" : `:${port}`}/${encodeURIComponent(database || (driver === "redis" ? "0" : ""))}${options}`;
  };
  const inputFor = (): StateQLCommandInput => {
    const connectionSource =
      source === "environment" ? { secret_env: environment.trim() } : source === "saved" ? {} : { target: target() };
    if (source === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environment.trim()))
      throw new Error("Enter a valid environment variable name.");
    if (profile) {
      return {
        command: "profile.update",
        name: profile.name,
        ...connectionSource,
        read_only: readOnly,
        ...(remember ? { remember: true } : {}),
      };
    }
    return {
      command: "connect",
      ...connectionSource,
      read_only: readOnly,
      ...(source === "target" && remember ? { remember: true } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
    };
  };
  const submit = async (action: SetupAction) => {
    if (locked) return;
    try {
      const input = inputFor();
      if ((action === "save" || action === "save-connect") && !profile && !name.trim())
        throw new Error("Give the saved connection a name.");
      setSubmitting(true);
      setError("");
      await onSubmit(input, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid connection setup");
      setSubmitting(false);
    }
  };
  const remove = async () => {
    if (!onRemove || locked) return;
    try {
      setSubmitting(true);
      setError("");
      await onRemove(forget);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove saved connection");
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="database-connect"
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="database-connect-title">
      <form
        onSubmit={event => {
          event.preventDefault();
          void submit("connect");
        }}>
        <header>
          <strong id="database-connect-title">{profile ? `Set up ${profile.name}` : "Connect to a database"}</strong>
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
              The saved credential remains in the OS vault. Its value is never shown here.
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
              <small>The variable is read on the Pylon server.</small>
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
                  <p className="database-muted">
                    A separate secure prompt requests the password. It is never saved with queries.
                  </p>
                  <label className="database-check">
                    <input
                      type="checkbox"
                      checked={remember}
                      disabled={locked}
                      onChange={event => setRemember(event.target.checked)}
                    />{" "}
                    Remember credentials in the OS vault
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
          {pending && (
            <div className="database-prompt">
              <UiDialog key={pending.requestId} request={pending} />
            </div>
          )}
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
          {!profile && (
            <button className="primary-button" type="submit" disabled={locked}>
              Connect
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
