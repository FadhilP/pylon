import { useEffect, useRef, useState } from "react";
import type { StateQLCommandInput } from "../shared/protocol/snapshots";
import type { DatabaseDriver } from "../shared/database-workspace";

export function DatabaseConnectDialog({
  profiles,
  onClose,
  onSubmit,
}: {
  profiles: string[];
  onClose: () => void;
  onSubmit: (input: StateQLCommandInput, saveProfile: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState(profiles.length ? "profile" : "target");
  const [driver, setDriver] = useState<DatabaseDriver>("postgres");
  const [profile, setProfile] = useState(profiles[0] ?? "");
  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [file, setFile] = useState("");
  const [environment, setEnvironment] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [remember, setRemember] = useState(false);
  const [save, setSave] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className="database-connect" onCancel={onClose} aria-labelledby="database-connect-title">
      <form
        onSubmit={event => {
          event.preventDefault();
          try {
            let input: StateQLCommandInput;
            if (source === "profile") input = { command: "connect", profile };
            else if (source === "environment")
              input = {
                command: "connect",
                secret_env: environment.trim(),
                read_only: readOnly,
                ...(name ? { name } : {}),
              };
            else {
              if (
                driver !== "sqlite" &&
                (!host.trim() ||
                  !database.trim() ||
                  !Number.isInteger(Number(port)) ||
                  Number(port) < 1 ||
                  Number(port) > 65535)
              )
                throw new Error("Enter a host, database, and valid port.");
              if (driver === "sqlite" && !file.trim())
                throw new Error("Enter a database file path on the Pylon server.");
              const target =
                driver === "sqlite"
                  ? file.trim()
                  : `${driver}://${username ? encodeURIComponent(username) + "@" : ""}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}/${encodeURIComponent(database)}`;
              input = { command: "connect", target, read_only: readOnly, remember, ...(name ? { name } : {}) };
            }
            if (save && !name.trim()) throw new Error("Give the saved connection a name.");
            onSubmit(input, save && source !== "profile");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Invalid connection");
          }
        }}>
        <header>
          <strong id="database-connect-title">Connect to a database</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close connection dialog">
            ×
          </button>
        </header>
        <div className="database-connect-fields">
          <label>
            Source
            <select value={source} onChange={event => setSource(event.target.value)}>
              <option value="target">New connection</option>
              <option value="profile" disabled={!profiles.length}>
                Saved connection
              </option>
              <option value="environment">Environment variable</option>
            </select>
          </label>
          {source === "profile" ? (
            <label>
              Connection
              <select value={profile} onChange={event => setProfile(event.target.value)}>
                {profiles.map(value => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                Name
                <input
                  value={name}
                  maxLength={200}
                  onChange={event => setName(event.target.value)}
                  placeholder="Optional connection name"
                />
              </label>
              {source === "environment" ? (
                <label>
                  Environment variable
                  <input
                    required
                    pattern="[A-Za-z_][A-Za-z0-9_]*"
                    value={environment}
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
                      onChange={event => {
                        const next = event.target.value as DatabaseDriver;
                        setDriver(next);
                        setPort(next === "postgres" ? "5432" : next === "mysql" ? "3306" : "27017");
                      }}>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mysql">MySQL</option>
                      <option value="mongodb">MongoDB</option>
                      <option value="sqlite">SQLite</option>
                    </select>
                  </label>
                  {driver === "sqlite" ? (
                    <label>
                      Database file
                      <input
                        required
                        value={file}
                        onChange={event => setFile(event.target.value)}
                        placeholder="Server filesystem path"
                      />
                    </label>
                  ) : (
                    <>
                      <div className="database-connect-pair">
                        <label>
                          Host
                          <input required value={host} onChange={event => setHost(event.target.value)} />
                        </label>
                        <label>
                          Port
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            required
                            value={port}
                            onChange={event => setPort(event.target.value)}
                          />
                        </label>
                      </div>
                      <label>
                        Database
                        <input required value={database} onChange={event => setDatabase(event.target.value)} />
                      </label>
                      <label>
                        Username
                        <input
                          autoComplete="off"
                          value={username}
                          onChange={event => setUsername(event.target.value)}
                        />
                      </label>
                      <p className="database-muted">
                        A separate secure prompt requests the password. It is never saved with queries.
                      </p>
                      <label className="database-check">
                        <input
                          type="checkbox"
                          checked={remember}
                          onChange={event => setRemember(event.target.checked)}
                        />
                        Remember credentials in the OS vault
                      </label>
                    </>
                  )}
                </>
              )}
              <label className="database-check">
                <input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />
                Read-only connection
              </label>
              <label className="database-check">
                <input type="checkbox" checked={save} onChange={event => setSave(event.target.checked)} />
                Save this connection
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="database-notice">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit">
            Connect
          </button>
        </footer>
      </form>
    </dialog>
  );
}
