import { useEffect, useRef, useState } from "react";
import "./database-workspace.css";
import {
  IconDatabase,
  IconPlus,
  IconRefresh,
  IconX,
  IconChevronRight,
  IconTable,
  IconSearch,
  IconPlayerStop,
  IconCopy,
  IconDeviceFloppy,
  IconPlugOff,
} from "@tabler/icons-react";
import { parseStateQLPanelCommand, type StateQLCatalogObject } from "pi-stateql/stateql-command";
import { DatabaseObjectBrowser } from "./database-object-browser";
import type { StateQLCommandInput, StateQLCommandResult, StateQLSnapshot } from "../../shared/protocol/snapshots";
import {
  databaseCell,
  databaseRecord,
  databaseSnapshotMatchesRuntime,
  isDatabaseResult,
  readDatabaseDrafts,
  saveDatabaseDraft,
  clearDatabaseDrafts,
  type DatabaseQuery,
  type DatabaseResult,
  type DatabaseDraft,
} from "./database-workspace";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { UiDialog } from "../runtime/remote-ui-dialog";
import { DatabaseHistory } from "./database-history";
import { DatabaseConnectDialog, type DatabaseProfileSetup } from "./database-connect-dialog";
import { DatabaseSetupError, submitDatabaseSetup, type DatabaseSetupStep } from "./database-setup";
import { DatabaseResultGrid } from "./database-result-grid";
import { DatabaseQueryEditor } from "./database-query-editor";

interface QueryTab extends DatabaseQuery {
  params: string;
  kind: "query" | "table" | "object";
  table?: { schema?: string; name: string };
  sub: string;
  metadata?: Record<string, unknown>;
  result?: DatabaseResult;
  response?: StateQLCommandResult;
  detached?: boolean;
  plan?: { handle: string; expires: string; text: string; params: string };
}
const tabFromDraft = (tab: DatabaseQuery): QueryTab => ({ ...tab, params: "", kind: "query", sub: "data" });

export function DatabasePanel({ live, onClose }: { live: RuntimeStoreSnapshot; onClose: () => void }) {
  const runtimeScope = `${live.runtime?.sessionId}:${live.runtime?.sessionGeneration}`;
  const ready = live.connection === "connected" && live.runtime?.ready === true;
  const [receivedSnapshot, setSnapshot] = useState<StateQLSnapshot>();
  const snapshot =
    ready && databaseSnapshotMatchesRuntime(receivedSnapshot, live.runtime) ? receivedSnapshot : undefined;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tabs, setTabs] = useState<QueryTab[]>([]);
  const [active, setActive] = useState("history");
  const [height, setHeight] = useState(220);
  const [busy, setBusy] = useState("");
  const [busyTab, setBusyTab] = useState("");
  const [setup, setSetup] = useState<{ operationId: string; profile?: DatabaseProfileSetup }>();
  const setupOperation = useRef<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<Array<{ profile: string; read_only: boolean }>>([]);
  const [transaction, setTransaction] = useState<Record<string, unknown>>();
  const [isolation, setIsolation] = useState("serializable");
  const [allowUnbounded, setAllowUnbounded] = useState(false);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState("");
  const [profileRevision, setProfileRevision] = useState(0);
  const [objectRevision, setObjectRevision] = useState(0);
  const dirtyTabs = useRef(new Set<string>());
  const request = useRef<AbortController | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const savedScope = useRef("");
  const refreshRevision = useRef(0);
  const scope = snapshot
    ? JSON.stringify([snapshot.actor_id, snapshot.session.session_id, snapshot.connection?.connection_id ?? "unbound"])
    : "";
  const connected = Boolean(snapshot?.connection);
  // The ref changes synchronously before the command starts; React state can still contain
  // the dialog's previous correlation ID when the first local SSE prompt arrives.
  const setupOperationId = setupOperation.current ?? setup?.operationId;
  const setupPending =
    setup &&
    live.pendingUi?.surface === "database" &&
    live.pendingUi.operationId === setupOperationId &&
    live.generation === live.runtime?.sessionGeneration
      ? live.pendingUi
      : undefined;
  const pending = live.pendingUi?.surface === "database" && (!setup || !setupPending) ? live.pendingUi : undefined;
  const setupStatus = setupOperationId
    ? live.runtime?.extensionUi.statuses.find(status => status.key === `database-setup:${setupOperationId}`)?.text
    : undefined;
  const setupStep: DatabaseSetupStep | undefined =
    setupStatus === "resolving" || setupStatus === "approving" || setupStatus === "connecting" || setupStatus === "saving"
      ? setupStatus
      : undefined;
  const locked = !ready || !snapshot || Boolean(busy) || Boolean(live.pendingUi);
  const inTransaction = Boolean(snapshot?.transaction);
  const ownTransaction = snapshot?.transaction?.owner_actor_id === snapshot?.actor_id;
  const readOnly = snapshot?.connection?.read_only !== false;
  const driver = snapshot?.connection?.driver ?? "postgres";
  const toolRevision = live.runtime?.conversation.tools
    .filter(tool => tool.name === "stateql" && tool.status !== "running")
    .map(tool => `${tool.id}:${tool.status}`)
    .join("|");

  const refresh = async (signal?: AbortSignal) => {
    const revision = ++refreshRevision.current;
    try {
      const next = await runtimeStore.stateqlSnapshot(100, signal);
      if (!signal?.aborted && revision === refreshRevision.current) setSnapshot(next);
      return next;
    } catch (cause) {
      if (!signal?.aborted && revision === refreshRevision.current)
        setError(cause instanceof Error ? cause.message : "Database is unavailable.");
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    if (ready) void refresh(controller.signal);
    else setSnapshot(undefined);
    return () => controller.abort();
  }, [runtimeScope, ready, toolRevision]);
  useEffect(() => {
    setSnapshot(undefined);
    request.current?.abort();
    setupOperation.current = undefined;
    setSetup(undefined);
    dirtyTabs.current.clear();
    setTabs([]);
  }, [runtimeScope]);
  useEffect(
    () => () => {
      setupOperation.current = undefined;
      request.current?.abort();
    },
    [runtimeScope],
  );
  useEffect(() => {
    if (!scope || scope === savedScope.current) return;
    savedScope.current = scope;
    request.current?.abort();
    request.current = null;
    setBusy("");
    setBusyTab("");
    setTransaction(undefined);
    setIsolation(driver === "mongodb" ? "snapshot" : "serializable");
    let draft: DatabaseDraft | undefined;
    try {
      draft = readDatabaseDrafts(localStorage).find(item => item.scope === scope);
    } catch {
      setNotice("Browser storage is unavailable. Queries remain in memory.");
    }
    setTabs(current => [
      ...current.filter(tab => dirtyTabs.current.has(tab.id)).map(tab => ({ ...tab, detached: true })),
      ...(draft?.tabs.map(tabFromDraft) ?? []),
    ]);
    setActive(current => (dirtyTabs.current.has(current) ? current : (draft?.active ?? "history")));
    setHeight(draft?.height ?? 220);
  }, [scope]);
  useEffect(() => {
    if (!scope || savedScope.current !== scope) return;
    const timeout = window.setTimeout(() => {
      try {
        saveDatabaseDraft(localStorage, {
          version: 1,
          scope,
          sessionId: snapshot!.actor_id,
          tabs: tabs.filter(tab => tab.kind === "query"),
          active,
          height,
          updatedAt: Date.now(),
        });
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Browser storage is unavailable. Queries remain in memory.");
      }
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [tabs, active, height, scope]);
  useEffect(() => {
    if (!tabs.some(tab => tab.plan)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tabs.some(tab => Boolean(tab.plan))]);

  const run = async (
    input: StateQLCommandInput,
    tabId = "",
    operationId?: string,
  ): Promise<StateQLCommandResult | undefined> => {
    if (request.current || !ready || !snapshotRef.current) return;
    if (["connect", "connection.setup", "disconnect"].includes(input.command) && dirtyTabs.current.size) {
      setError("Apply or discard pending table edits before changing connection.");
      return;
    }
    const parsed = parseStateQLPanelCommand(input);
    if (!parsed) {
      setError("Check the command and JSON parameters. The input exceeds the supported shape or limits.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const startScope = savedScope.current;
    setBusy(input.command);
    setBusyTab(tabId);
    setError("");
    try {
      const response = await runtimeStore.stateqlCommand(
        parsed,
        controller.signal,
        snapshotRef.current?.connection?.connection_id ?? null,
        operationId,
      );
      if (controller.signal.aborted || startScope !== savedScope.current) return;
      if (response.status === "declined") setNotice("Operation declined. No command was submitted.");
      else if (!response.response.ok)
        setError(
          `${response.response.error.code}: ${response.response.error.message}${response.response.error.executed ? " The database may have executed this operation; inspect its status before retrying." : ""}`,
        );
      else setNotice(response.response.warnings.map(warning => warning.message).join(" "));
      return response;
    } catch (cause) {
      if (startScope !== savedScope.current) return;
      setError(
        controller.signal.aborted
          ? "Request cancelled. A write may already have executed; refresh status before retrying."
          : cause instanceof Error
            ? cause.message
            : "Database request failed.",
      );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy("");
        setBusyTab("");
      }
      if (ready) await refresh();
    }
  };
  const setupCommand = async (input: StateQLCommandInput, operationId: string) => {
    const response = await run(input, "", operationId);
    if (response?.status === "completed" && response.response.ok) {
      const setupData = databaseRecord(response.response.data) ? response.response.data.setup : undefined;
      if (databaseRecord(setupData) && databaseRecord(setupData.error)) {
        const message = typeof setupData.error.message === "string" ? setupData.error.message : "Saving connection failed.";
        throw new DatabaseSetupError(message, true);
      }
      return;
    }
    if (response?.status === "completed" && !response.response.ok)
      throw new DatabaseSetupError(`${response.response.error.code}: ${response.response.error.message}`);
    if (response?.status === "declined") throw new DatabaseSetupError("Operation declined. No command was submitted.");
    throw new DatabaseSetupError("Database setup did not complete. Try again.");
  };
  const closeSetup = () => {
    setupOperation.current = undefined;
    request.current?.abort();
    setSetup(undefined);
  };
  const submitSetup = async (input: StateQLCommandInput, operationId: string) => {
    if (!setup) return;
    setupOperation.current = operationId;
    setSetup(current => (current ? { ...current, operationId } : current));
    await submitDatabaseSetup(
      input,
      command => {
        if (setupOperation.current !== operationId) throw new Error("Database setup cancelled.");
        return setupCommand(command, operationId);
      },
      refreshProfiles,
    );
    setSetup(current => (current?.operationId === operationId ? undefined : current));
  };
  const removeSetupProfile = async (forgetCredential: boolean) => {
    if (!setup?.profile) return;
    await setupCommand(
      { command: "profile.remove", name: setup.profile.name, forget_credential: forgetCredential },
      setup.operationId,
    );
    loadProfiles();
    setSetup(undefined);
  };
  const data = (response?: StateQLCommandResult): Record<string, unknown> | undefined =>
    response?.status === "completed" && response.response.ok && databaseRecord(response.response.data)
      ? response.response.data
      : undefined;
  const update = (id: string, patch: Partial<QueryTab>) =>
    setTabs(current =>
      current.map(tab =>
        tab.id === id
          ? { ...tab, ...patch, ...("text" in patch || "params" in patch ? { plan: undefined } : {}) }
          : tab,
      ),
    );
  const add = (text = "", table?: QueryTab["table"], result?: DatabaseResult) => {
    const existing = table && tabs.find(tab => tab.table?.name === table.name && tab.table?.schema === table.schema);
    if (existing) {
      setActive(existing.id);
      return existing.id;
    }
    if (tabs.length >= 20) {
      setError("Close a tab before opening another (20 maximum).");
      return;
    }
    const id = crypto.randomUUID();
    setTabs(current => [
      ...current,
      {
        id,
        title: table?.name ?? `Query ${current.length + 1}`,
        text,
        driver,
        saved: !table,
        params: "",
        kind: table ? "table" : "query",
        table,
        sub: "data",
        result,
      },
    ]);
    setActive(id);
    return id;
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Clipboard access failed.");
    }
  };
  const close = (id: string) => {
    if (dirtyTabs.current.has(id) && !window.confirm("Discard pending table edits and close this tab?")) return;
    dirtyTabs.current.delete(id);
    if (busyTab === id) request.current?.abort();
    const index = tabs.findIndex(tab => tab.id === id);
    setTabs(current => current.filter(tab => tab.id !== id));
    if (active === id) setActive(tabs[index - 1]?.id ?? "history");
    window.requestAnimationFrame(() =>
      document.getElementById(`database-tab-${tabs[index - 1]?.id ?? "history"}`)?.focus(),
    );
  };
  const execute = async (tab: QueryTab, action: "read" | "plan" | "stage" | "apply") => {
    if (tab.detached) {
      setError("This result belongs to a previous connection. Discard edits and reopen the table.");
      return;
    }
    if (dirtyTabs.current.has(tab.id)) {
      setError("Apply or discard pending table edits before reloading.");
      return;
    }
    let input: StateQLCommandInput;
    try {
      if (action === "apply") {
        if (!tab.plan || Date.parse(tab.plan.expires) <= Date.now()) return;
        input = { command: "apply", handle: tab.plan.handle };
      } else if (tab.kind === "table") input = { command: "table.read", table: tab.table!, limit: 1000 };
      else if (tab.driver === "redis")
        input = {
          command: action === "read" ? "redis.query" : action === "plan" ? "redis.plan" : "redis.exec",
          redis: JSON.parse(tab.text),
        };
      else if (tab.driver === "mongodb")
        input = {
          command: action === "read" ? "mongo.query" : action === "plan" ? "mongo.plan" : "mongo.exec",
          mongo: JSON.parse(tab.text),
          ...(action !== "read" ? { allow_unbounded: allowUnbounded, allow_destructive: allowDestructive } : {}),
        } as StateQLCommandInput;
      else
        input = {
          command: action === "read" ? "query" : action === "plan" ? "plan" : "exec",
          sql: tab.text,
          ...(tab.params.trim() ? { params: JSON.parse(tab.params) } : {}),
          ...(action !== "read" ? { allow_unbounded: allowUnbounded, allow_destructive: allowDestructive } : {}),
        };
    } catch {
      setError("Enter valid JSON for the command and parameters.");
      return;
    }
    update(tab.id, { plan: undefined });
    const response = await run(input, tab.id);
    const value = data(response);
    setTabs(current =>
      current.map(item => {
        if (item.id !== tab.id) return item;
        return {
          ...item,
          response,
          ...(value && isDatabaseResult(value)
            ? { result: value, ...(typeof value.query === "string" ? { text: value.query } : {}) }
            : {}),
          ...(value &&
          typeof value.plan_id === "string" &&
          typeof value.expires_at === "string" &&
          item.text === tab.text &&
          item.params === tab.params
            ? { plan: { handle: value.plan_id, expires: value.expires_at, text: tab.text, params: tab.params } }
            : {}),
        };
      }),
    );
  };
  // Metadata requests do not recurse through run()/snapshot refresh or lock query controls.
  const refreshProfiles = async (signal?: AbortSignal) => {
    try {
      const response = await runtimeStore.stateqlCommand({ command: "profile.list" }, signal);
      const value = data(response);
      if (signal?.aborted) return;
      if (!Array.isArray(value?.profiles)) {
        const failure =
          response.status === "completed" && !response.response.ok
            ? response.response.error.message
            : "No profile list was returned.";
        throw new Error(`Could not refresh saved connections: ${failure}`);
      }
      setProfiles(value.profiles as typeof profiles);
    } catch (cause) {
      if (!signal?.aborted) setError(String(cause));
    }
  };
  const loadProfiles = () => setProfileRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    if (ready) void refreshProfiles(controller.signal);
    return () => controller.abort();
  }, [runtimeScope, ready, toolRevision, profileRevision]);
  const openObject = async (object: StateQLCatalogObject) => {
    if (["table", "view", "collection"].includes(object.kind)) {
      const table = { name: object.name, ...(object.schema ? { schema: object.schema } : {}) };
      add("", table);
    } else {
      const id = add();
      if (!id) return;
      update(id, { kind: "object", title: object.name, saved: false, sub: "definition" });
      const value = data(await run({ command: "object.describe", object }, id));
      if (value) update(id, { metadata: value });
    }
  };
  const inspectTab = async (tab: QueryTab, sub: string) => {
    update(tab.id, { sub });
    if (sub === "data") return;
    const table = [tab.table?.schema, tab.table?.name].filter(Boolean).join(".");
    const value = data(
      await run({ command: "inspect", kind: sub as "columns" | "indexes" | "constraints", table }, tab.id),
    );
    if (value) update(tab.id, { metadata: value });
  };
  const transactionAction = async (
    command: "transaction.begin" | "transaction.status" | "transaction.commit" | "transaction.rollback",
  ) => {
    const input: StateQLCommandInput =
      command === "transaction.begin"
        ? { command, isolation }
        : {
            command,
            handle:
              snapshot?.transaction?.transaction_id ??
              (typeof transaction?.transaction_id === "string" ? transaction.transaction_id : undefined),
          };
    const value = data(await run(input));
    if (value) setTransaction(value);
  };
  const reconciledTransaction = useRef("");
  useEffect(() => {
    const handle = snapshot?.transaction?.transaction_id;
    if (!handle) {
      reconciledTransaction.current = "";
      return;
    }
    if (locked || reconciledTransaction.current === handle) return;
    reconciledTransaction.current = handle;
    void transactionAction("transaction.status");
  }, [snapshot?.transaction?.transaction_id, locked]);
  const bindOldDraft = () => {
    let drafts;
    try {
      drafts = readDatabaseDrafts(localStorage)
        .filter(item => item.sessionId === snapshot?.actor_id && item.scope !== scope)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      setError("Browser storage is unavailable.");
      return;
    }
    if (!drafts[0]) {
      setNotice("No saved queries from another connection.");
      return;
    }
    setTabs(
      drafts[0].tabs
        .filter(tab => tab.driver === driver)
        .map(tab => tabFromDraft({ ...tab, id: crypto.randomUUID(), saved: false })),
    );
    setActive("history");
    setNotice("Imported query text into this connection. Review it before running.");
  };

  return (
    <aside id="database-panel" className="inspector database-panel is-open" aria-labelledby="database-panel-title">
      <div className="stateql-workspace">
        <header className="panel-head">
          <IconDatabase size={18} aria-hidden="true" />
          <span className="section-kicker" id="database-panel-title">
            Database
          </span>
          <span className="spacer" />
          <button
            className="icon-button"
            type="button"
            title="Refresh database"
            aria-label="Refresh database"
            disabled={!ready}
            onClick={() => {
              void refresh();
              loadProfiles();
              setObjectRevision(value => value + 1);
            }}>
            <IconRefresh size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Close database"
            onClick={() => {
              if (!dirtyTabs.current.size || window.confirm("Discard pending table edits and close database?"))
                onClose();
            }}>
            <IconX size={17} />
          </button>
        </header>
        <section className="stateql-connection-strip" aria-label="Database connection">
          <span className={`overview-orb ${connected ? "is-done" : "is-step"}`} aria-hidden="true" />
          <div className="stateql-connection-primary">
            <strong className="mono">{snapshot?.connection?.name ?? "No active connection"}</strong>
            <span>{connected ? `${driver} / ${readOnly ? "read-only" : "read-write"}` : "Disconnected"}</span>
          </div>
          <span className="database-muted">{snapshot?.connection?.database}</span>
          {snapshot?.connection?.alias && (
            <button
              type="button"
              className="database-alias-chip"
              title="Copy connection reference"
              aria-label="Copy connection reference"
              onClick={() => void copy(snapshot.connection!.alias!)}>
              <code>{snapshot.connection.alias}</code>
              <IconCopy size={13} />
            </button>
          )}
          <span className="spacer" />
          {connected && (
            <button
              type="button"
              className="icon-button"
              title="Disconnect"
              aria-label="Disconnect"
              disabled={locked || inTransaction}
              onClick={() => void run({ command: "disconnect" })}>
              <IconPlugOff size={16} />
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={locked || inTransaction}
            onClick={() => setSetup({ operationId: crypto.randomUUID() })}>
            Connect
          </button>
        </section>
        {pending && (
          <div className="database-prompt">
            <UiDialog key={pending.requestId} request={pending} />
          </div>
        )}
        {(inTransaction || transaction) && (
          <div className="database-transaction" role="status">
            <strong>{snapshot?.transaction?.state ?? databaseCell(transaction?.state)} transaction</strong>
            <span>
              {transaction?.pending_writes !== undefined
                ? `${transaction.pending_writes} staged writes`
                : "Writes are staged until commit"}
            </span>
            <span className="database-muted">
              {ownTransaction
                ? "yours"
                : (snapshot?.transaction?.owner_actor_id ?? databaseCell(transaction?.owner_actor_id))}
            </span>
            {transaction?.isolation_level !== undefined && (
              <span>
                {databaseCell(transaction.isolation_level)} · {databaseCell(transaction.statements)} statements ·{" "}
                {Math.floor(Number(transaction.age_ms) / 1000)}s at last status · start{" "}
                {databaseCell(transaction.start_state_version)}
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="text-button"
              disabled={locked}
              onClick={() => void transactionAction("transaction.status")}>
              Status
            </button>
            <button
              type="button"
              className="text-button"
              disabled={locked || !inTransaction || !ownTransaction}
              onClick={() => void transactionAction("transaction.rollback")}>
              Roll back
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={locked || !inTransaction || !ownTransaction}
              onClick={() => void transactionAction("transaction.commit")}>
              Commit
            </button>
            {!inTransaction && (
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss transaction status"
                onClick={() => setTransaction(undefined)}>
                ×
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="database-notice is-error" role="alert">
            {error}
            <button type="button" className="text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </p>
        )}
        {notice && (
          <p className="database-notice" role="status">
            {notice}
            <button type="button" className="text-button" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </p>
        )}
        <div className="database-body">
          <aside className="stateql-objects" aria-label="Connections and objects">
            <label className="table-search database-rail-search">
              <IconSearch size={15} />
              <span className="sr-only">Search connections and objects</span>
              <input
                type="search"
                value={search}
                maxLength={200}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search…"
              />
            </label>
            <section>
              <header>
                <span className="section-kicker">Connections</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Load saved connections"
                  disabled={locked}
                  onClick={() => void loadProfiles()}>
                  <IconRefresh size={13} />
                </button>
              </header>
              {profiles
                .filter(profile => profile.profile.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .map(profile => (
                  <div className="database-profile" key={profile.profile}>
                    <button
                      type="button"
                      className="database-object"
                      disabled={locked || inTransaction}
                      onClick={() => void run({ command: "connect", profile: profile.profile })}>
                      <span className="overview-orb is-step" aria-hidden="true" />
                      <span>{profile.profile}</span>
                      <small>{profile.read_only ? "RO" : "RW"}</small>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${profile.profile}`}
                      disabled={locked}
                      onClick={() =>
                        void run({ command: "profile.show", name: profile.profile }).then(response => {
                          const value = data(response);
                          if (!databaseRecord(value)) return;
                          setSetup({
                            operationId: crypto.randomUUID(),
                            profile: {
                              name: profile.profile,
                              ...(typeof value.target === "string" ? { target: value.target } : {}),
                              ...(typeof value.secret_env === "string" ? { secretEnv: value.secret_env } : {}),
                              ...(typeof value.read_only === "boolean"
                                ? { readOnly: value.read_only }
                                : { readOnly: profile.read_only }),
                              hasCredential: typeof value.password_ref === "string" || typeof value.credential_ref === "string",
                            },
                          });
                        })
                      }>
                      …
                    </button>
                  </div>
                ))}
              {!profiles.length && (
                <button type="button" className="database-object" disabled={locked} onClick={() => void loadProfiles()}>
                  Load saved connections
                </button>
              )}
              <button
                type="button"
                className="database-object"
                disabled={locked || inTransaction}
                onClick={() => setSetup({ operationId: crypto.randomUUID() })}>
                <IconPlus size={14} />
                New connection
              </button>
            </section>
            <section>
              <header>
                <span className="section-kicker">Objects</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Refresh objects"
                  disabled={locked || !connected || inTransaction}
                  onClick={() => setObjectRevision(value => value + 1)}>
                  <IconRefresh size={13} />
                </button>
              </header>
              {snapshot?.connection ? (
                <DatabaseObjectBrowser
                  scope={`${runtimeScope}:${scope}`}
                  driver={driver}
                  connectionId={snapshot.connection.connection_id}
                  search={search}
                  disabled={!ready || inTransaction || Boolean(setup)}
                  refreshKey={objectRevision}
                  onOpen={object => {
                    if (!locked) void openObject(object);
                  }}
                />
              ) : (
                <p className="database-muted">Connect to browse objects.</p>
              )}
            </section>
            <section>
              <header>
                <span className="section-kicker">Saved queries</span>
              </header>
              <p className="database-muted">Saved text stays in this browser and may contain sensitive literals.</p>
              <button className="text-button" type="button" onClick={bindOldDraft}>
                Import from previous connection
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  try {
                    clearDatabaseDrafts(localStorage, snapshot?.actor_id ?? "", scope);
                    setTabs(current => current.map(tab => ({ ...tab, saved: false })));
                    setNotice("Saved queries cleared. Open tabs remain in memory.");
                  } catch {
                    setError("Browser storage is unavailable.");
                  }
                }}>
                Clear saved queries
              </button>
            </section>
          </aside>
          <main className="database-tabs-workspace">
            <div
              className="database-tabs"
              role="tablist"
              aria-label="Database tabs"
              onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const ids = ["history", ...tabs.map(tab => tab.id)];
                const index = ids.indexOf(active);
                const next =
                  event.key === "Home"
                    ? ids[0]!
                    : event.key === "End"
                      ? ids.at(-1)!
                      : ids[(index + (event.key === "ArrowLeft" ? ids.length - 1 : 1)) % ids.length]!;
                event.preventDefault();
                setActive(next);
                document.getElementById(`database-tab-${next}`)?.focus();
              }}>
              <button
                role="tab"
                type="button"
                id="database-tab-history"
                aria-selected={active === "history"}
                aria-controls="database-view-history"
                tabIndex={active === "history" ? 0 : -1}
                onClick={() => setActive("history")}>
                History
              </button>
              {tabs.map(tab => (
                <div className="database-tab" key={tab.id}>
                  <button
                    role="tab"
                    type="button"
                    id={`database-tab-${tab.id}`}
                    aria-controls={`database-view-${tab.id}`}
                    aria-selected={active === tab.id}
                    tabIndex={active === tab.id ? 0 : -1}
                    onClick={() => setActive(tab.id)}>
                    {busyTab === tab.id && <span className="overview-orb is-running" aria-label="Running" />}
                    <span>{tab.title}</span>
                    {!tab.saved && tab.text && <span className="database-dirty" aria-label="Not saved" />}
                  </button>
                  <button
                    type="button"
                    className="database-tab-close"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => close(tab.id)}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="text-button" aria-label="New query" onClick={() => add()}>
                <IconPlus size={14} />
              </button>
            </div>
            <div
              id="database-view-history"
              className="database-tab-panel"
              role="tabpanel"
              aria-labelledby="database-tab-history"
              hidden={active !== "history"}>
              <DatabaseHistory
                snapshot={snapshot}
                onOpen={text => {
                  add(text);
                  setNotice("Review retained SQL before running; parameters are not restored.");
                }}
                onResult={(handle, total) =>
                  add("", undefined, {
                    result_id: handle,
                    rows: total,
                    columns: [],
                    cached: false,
                    storage: { mode: "materialized", expires_at: undefined },
                  })
                }
                onReceipt={handle =>
                  void run({ command: "receipt", handle }).then(response => {
                    const value = data(response);
                    if (value)
                      setNotice(
                        `Operation ${value.operation_id}: ${value.status}, affected rows ${value.affected_rows ?? "unknown"}`,
                      );
                  })
                }
              />
            </div>
            {tabs.map(tab => (
              <div
                key={tab.id}
                id={`database-view-${tab.id}`}
                className="database-tab-panel"
                role="tabpanel"
                aria-labelledby={`database-tab-${tab.id}`}
                hidden={active !== tab.id}>
                <div className="database-toolbar">
                  {tab.kind === "query" ? (
                    <>
                      <input
                        aria-label="Query title"
                        className="database-title-input"
                        maxLength={100}
                        value={tab.title}
                        onChange={event => update(tab.id, { title: event.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Save query in this browser"
                        title="Save query in this browser"
                        aria-pressed={tab.saved}
                        onClick={() => update(tab.id, { saved: !tab.saved })}>
                        <IconDeviceFloppy size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Copy query"
                        title="Copy query"
                        onClick={() => void copy(tab.text)}>
                        <IconCopy size={16} />
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={tabs.indexOf(tab) === 0}
                        onClick={() =>
                          setTabs(current => {
                            const next = [...current];
                            const index = next.findIndex(item => item.id === tab.id);
                            [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                            return next;
                          })
                        }>
                        Move left
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={tabs.indexOf(tab) === tabs.length - 1}
                        onClick={() =>
                          setTabs(current => {
                            const next = [...current];
                            const index = next.findIndex(item => item.id === tab.id);
                            if (index < 0 || index >= next.length - 1) return current;
                            [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                            return next;
                          })
                        }>
                        Move right
                      </button>
                    </>
                  ) : (
                    <>
                      <strong className="mono">
                        {tab.kind === "object"
                          ? tab.title
                          : [tab.table?.schema, tab.table?.name].filter(Boolean).join(".")}
                      </strong>
                      <div className="database-segments" role="group" aria-label="Table view">
                        {(tab.kind === "table" ? ["data", "columns", "indexes", "constraints"] : []).map(sub => (
                          <button
                            type="button"
                            key={sub}
                            aria-pressed={tab.sub === sub}
                            disabled={locked || inTransaction}
                            onClick={() => void inspectTab(tab, sub)}>
                            {sub}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {tab.detached && (
                    <span role="alert">Previous connection · edits cannot be applied. Discard and reopen.</span>
                  )}
                  {tab.result && (
                    <button
                      type="button"
                      className="database-alias-chip"
                      title="Copy result reference"
                      aria-label="Copy result reference"
                      onClick={() => void copy(tab.result!.alias ?? tab.result!.result_id)}>
                      <code>{tab.result.alias ?? tab.result.result_id}</code>
                      <IconCopy size={13} />
                    </button>
                  )}
                  <span className="spacer" />
                  {!inTransaction && connected && !readOnly && driver !== "redis" && (
                    <>
                      <select
                        aria-label="Transaction isolation"
                        value={isolation}
                        onChange={event => setIsolation(event.target.value)}>
                        {(driver === "mongodb"
                          ? ["snapshot"]
                          : driver === "sqlite"
                            ? ["serializable"]
                            : driver === "postgres"
                              ? ["serializable", "repeatable read", "read committed"]
                              : ["serializable", "repeatable read", "read committed", "read uncommitted"]
                        ).map(value => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="text-button"
                        disabled={locked}
                        onClick={() => void transactionAction("transaction.begin")}>
                        Begin transaction
                      </button>
                    </>
                  )}
                </div>
                {tab.kind === "object" ? (
                  <div className="database-metadata">
                    <pre>
                      {tab.metadata
                        ? typeof tab.metadata.definition === "string"
                          ? tab.metadata.definition
                          : JSON.stringify(tab.metadata, null, 2)
                        : "Loading definition…"}
                    </pre>
                  </div>
                ) : tab.kind === "table" && tab.sub !== "data" ? (
                  <div className="database-metadata">
                    {tab.metadata ? (
                      Object.entries(tab.metadata).map(([key, value]) => (
                        <section key={key}>
                          <h3>{key}</h3>
                          {Array.isArray(value) ? (
                            value.length ? (
                              <table>
                                <thead>
                                  <tr>
                                    {Object.keys(value[0] ?? {}).map(name => (
                                      <th key={name}>{name}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {value.map((row, index) => (
                                    <tr key={index}>
                                      {Object.values(row as object).map((cell, i) => (
                                        <td key={i}>{databaseCell(cell)}</td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p>No {key} reported.</p>
                            )
                          ) : (
                            <p>{databaseCell(value)}</p>
                          )}
                        </section>
                      ))
                    ) : (
                      <p>Loading metadata…</p>
                    )}
                  </div>
                ) : (
                  <>
                    {tab.kind === "query" && (
                      <>
                        <div className="database-editor" style={{ height }}>
                          <DatabaseQueryEditor
                            text={tab.text}
                            driver={tab.driver}
                            active={active === tab.id}
                            onChange={text => update(tab.id, { text })}
                            onRun={() => {
                              if (!locked && connected && !inTransaction) void execute(tab, "read");
                            }}
                          />
                        </div>
                        <div
                          className="database-splitter"
                          role="separator"
                          aria-label="Editor height"
                          aria-orientation="horizontal"
                          aria-valuemin={120}
                          aria-valuemax={600}
                          aria-valuenow={height}
                          tabIndex={0}
                          onKeyDown={event => {
                            if (["ArrowUp", "ArrowDown"].includes(event.key)) {
                              event.preventDefault();
                              setHeight(value =>
                                Math.min(600, Math.max(120, value + (event.key === "ArrowUp" ? -20 : 20))),
                              );
                            }
                          }}
                          onPointerDown={event => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            event.currentTarget.dataset.start = String(event.clientY - height);
                          }}
                          onPointerMove={event => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId))
                              setHeight(
                                Math.max(120, Math.min(600, event.clientY - Number(event.currentTarget.dataset.start))),
                              );
                          }}
                          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
                        />
                      </>
                    )}
                    <div className="database-toolbar database-runbar">
                      {tab.kind === "query" && tab.driver !== "mongodb" && tab.driver !== "redis" && (
                        <input
                          className="database-params"
                          aria-label="JSON parameters"
                          value={tab.params}
                          placeholder="Parameters: [] or {}"
                          onChange={event => update(tab.id, { params: event.target.value })}
                        />
                      )}
                      <button
                        type="button"
                        className="primary-button"
                        disabled={locked || !connected || inTransaction || (tab.kind === "query" && !tab.text.trim())}
                        onClick={() => void execute(tab, "read")}>
                        {tab.kind === "table" ? "Load data" : "Run query"}
                      </button>
                      {tab.kind === "query" && (
                        <>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={
                              locked || !connected || readOnly || (inTransaction && !ownTransaction) || !tab.text.trim()
                            }
                            onClick={() => void execute(tab, inTransaction ? "stage" : "plan")}>
                            {inTransaction ? "Stage write" : "Plan write"}
                          </button>
                          {tab.driver !== "redis" && (
                            <details className="database-overflow">
                              <summary>Write safety</summary>
                              <div>
                                <label className="database-check">
                                  <input
                                    type="checkbox"
                                    checked={allowUnbounded}
                                    onChange={event => {
                                      setAllowUnbounded(event.target.checked);
                                      setTabs(current => current.map(tab => ({ ...tab, plan: undefined })));
                                    }}
                                  />
                                  Unbounded
                                </label>
                                <label className="database-check">
                                  <input
                                    type="checkbox"
                                    checked={allowDestructive}
                                    onChange={event => {
                                      setAllowDestructive(event.target.checked);
                                      setTabs(current => current.map(tab => ({ ...tab, plan: undefined })));
                                    }}
                                  />
                                  Destructive
                                </label>
                              </div>
                            </details>
                          )}
                        </>
                      )}
                      {tab.kind === "table" && tab.text && (
                        <button type="button" className="text-button" onClick={() => add(tab.text)}>
                          Open as query
                        </button>
                      )}
                      {busyTab === tab.id && (
                        <button
                          type="button"
                          className="icon-button"
                          title="Stop query"
                          aria-label="Stop query"
                          onClick={() => request.current?.abort()}>
                          <IconPlayerStop size={16} />
                        </button>
                      )}
                      <span className="spacer" />
                      <small>{tab.kind === "table" ? "Sample: up to 1,000 rows" : tab.driver}</small>
                    </div>
                    {tab.plan && (
                      <div className="database-plan" role="status">
                        <span>
                          Write plan <code>{tab.plan.handle}</code> ·{" "}
                          {Date.parse(tab.plan.expires) <= now ? "Expired" : "Ready for confirmation"}
                        </span>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={locked || inTransaction || Date.parse(tab.plan.expires) <= now}
                          onClick={() => void execute(tab, "apply")}>
                          Apply plan
                        </button>
                      </div>
                    )}
                    {tab.response?.status === "completed" && (
                      <div className="database-status">
                        <span>
                          {tab.response.response.ok
                            ? databaseRecord(tab.response.response.data) &&
                              tab.response.response.data.status === "pending"
                              ? "Staged · awaiting commit"
                              : "Completed"
                            : tab.response.response.error.code}
                        </span>
                        <span>{tab.response.response.meta.duration_ms} ms</span>
                        <span>{tab.response.response.meta.state_version}</span>
                        <span>{tab.response.response.meta.state_confidence}</span>
                      </div>
                    )}
                    {tab.result ? (
                      <DatabaseResultGrid
                        key={tab.result.result_id}
                        result={tab.result}
                        scope={runtimeScope}
                        editable={tab.kind === "table" && !tab.detached && !readOnly && !inTransaction}
                        disabled={locked || tab.detached}
                        suspended={Boolean(tab.detached)}
                        onDirtyChange={dirty => {
                          if (dirty) dirtyTabs.current.add(tab.id);
                          else dirtyTabs.current.delete(tab.id);
                        }}
                        onCommand={input => (tab.detached ? Promise.resolve(undefined) : run(input, tab.id))}
                        onPlanChanges={updates =>
                          tab.detached
                            ? Promise.resolve(undefined)
                            : run({ command: "table.plan.batch", updates }, tab.id)
                        }
                        onSaved={() => {
                          dirtyTabs.current.delete(tab.id);
                          setNotice("Changes saved. Reloading table data.");
                          void execute(tab, "read");
                        }}
                      />
                    ) : (
                      <div className="database-empty">
                        <IconDatabase size={24} />
                        <strong>
                          {busyTab === tab.id
                            ? "Running…"
                            : connected
                              ? "Ready when you are"
                              : "Connect to get started"}
                        </strong>
                        <p>
                          {inTransaction
                            ? "Stage writes, then commit or roll back."
                            : tab.kind === "table"
                              ? "Load a bounded sample from this table."
                              : "Run a read query or plan a write."}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </main>
        </div>
        {!ready && (
          <p className="database-notice" role="status">
            Waiting for the runtime connection…
          </p>
        )}
        {setup && (
          <DatabaseConnectDialog
            profile={setup.profile}
            pending={setupPending}
            generation={live.generation ?? 0}
            step={setupStep}
            suspended={Boolean(live.pendingUi && !setupPending)}
            onClose={closeSetup}
            onSubmit={submitSetup}
            onRemove={setup.profile ? removeSetupProfile : undefined}
          />
        )}
      </div>
    </aside>
  );
}
