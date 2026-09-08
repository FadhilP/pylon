import { useEffect, useMemo, useState } from "react";
import { runtimeStore } from "./runtime/event-store";
import { isStateQLSnapshot } from "../shared/protocol/validation";
import { databaseRecord } from "../shared/database-workspace";
import { buildStateQLActivity, stateqlActivityStatus, isInternalStateQLActivity } from "../shared/stateql-notebook";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import type { StateQLSnapshot } from "../shared/protocol/snapshots";
import { displayTime } from "./format";
import { DatabaseSyntax } from "./database-query-editor";
import type { StateQLActivityItem } from "../shared/stateql-notebook";

function activityLabel(item: StateQLActivityItem): string {
  if (item.command.startsWith("inspect.")) {
    const kind = item.command.slice(8);
    const action =
      kind === "schema"
        ? "Browse database objects"
        : kind === "editable"
          ? "Check table editability"
          : `Inspect ${kind}`;
    return item.target ? `${action} · ${item.target}` : action;
  }
  if (["rows", "show", "count", "columns", "result"].includes(item.command)) {
    const action =
      item.command === "columns"
        ? "Inspect result columns"
        : item.command === "count"
          ? "Count stored rows"
          : item.command === "rows"
            ? "Read cached rows"
            : "Stored result";
    return [
      action,
      item.handle,
      item.result?.alias,
      item.result ? `${item.result.rows.toLocaleString()} stored rows` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return item.sql ?? item.command;
}

export function DatabaseHistory({
  snapshot,
  onOpen,
  onResult,
  onReceipt,
}: {
  snapshot?: StateQLSnapshot;
  onOpen: (text: string) => void;
  onResult: (handle: string, total: number) => void;
  onReceipt: (handle: string) => void;
}) {
  const [origin, setOrigin] = useState("all");
  const [facet, setFacet] = useState("all");
  const [page, setPage] = useState(0);
  const [showInternal, setShowInternal] = useState(false);
  const [internalSnapshot, setInternalSnapshot] = useState<StateQLSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setInternalSnapshot(undefined);
    setError("");
    if (showInternal && snapshot)
      void runtimeStore
        .stateqlCommand(
          { command: "history", limit: 100 },
          controller.signal,
          snapshot.connection?.connection_id ?? null,
        )
        .then(result => {
          if (controller.signal.aborted) return;
          const data = result.status === "completed" && result.response.ok ? result.response.data : undefined;
          const next = {
            ...snapshot,
            history:
              databaseRecord(data) && Array.isArray(data.history)
                ? data.history.map(item =>
                    databaseRecord(item)
                      ? { ...item, sql: typeof item.sql === "string" ? item.sql.slice(0, 1024) : null }
                      : item,
                  )
                : undefined,
          };
          if (!isStateQLSnapshot(next)) throw new Error("Could not load internal history.");
          setInternalSnapshot(next);
        })
        .catch(cause => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load history.");
        });
    return () => controller.abort();
  }, [showInternal, snapshot?.session.session_id, snapshot?.connection?.connection_id]);
  const activity = useMemo(() => {
    const source = showInternal ? internalSnapshot : snapshot;
    return source ? buildStateQLActivity(source) : [];
  }, [snapshot, internalSnapshot, showInternal]);
  const items = activity.filter(
    item =>
      (showInternal || !isInternalStateQLActivity(item)) &&
      (origin === "all" ||
        (origin === "system" ? ["system", "api"].includes(item.origin ?? "") : item.origin === origin)) &&
      (facet === "all" || item.tags.includes(facet as "read" | "write" | "error")),
  );
  const current = Math.min(page, Math.max(0, Math.ceil(items.length / 25) - 1));
  return (
    <div className="database-history">
      {error && (
        <p className="database-notice" role="alert">
          {error}
        </p>
      )}
      <div className="database-toolbar">
        <div className="database-segments" role="group" aria-label="Activity origin">
          {[
            ["all", "All"],
            ["user", "Yours"],
            ["model", "Agent"],
            ["system", "System / API"],
            ["legacy", "Legacy"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={origin === value}
              onClick={() => {
                setOrigin(value!);
                setPage(0);
              }}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <select
          aria-label="Activity type"
          value={facet}
          onChange={event => {
            setFacet(event.target.value);
            setPage(0);
          }}>
          <option value="all">All activity</option>
          <option value="read">Reads</option>
          <option value="write">Writes</option>
          <option value="error">Errors</option>
        </select>
        <button
          type="button"
          className="icon-button"
          title="Show internal activity"
          aria-label="Show internal activity"
          aria-pressed={showInternal}
          onClick={() => {
            setShowInternal(!showInternal);
            setPage(0);
          }}>
          {showInternal ? <IconEye size={16} /> : <IconEyeOff size={16} />}
        </button>
      </div>
      <div className="stateql-rail">
        {items.slice(current * 25, current * 25 + 25).map(item => {
          const status = stateqlActivityStatus(item);
          const label = activityLabel(item);
          const planned = ["plan", "mongo.plan", "table.plan"].includes(item.command);
          const state =
            status.tone === "danger" ? "failed" : planned ? "step" : status.tone === "success" ? "done" : "neutral";
          return (
            <details className="seam-block" key={item.id}>
              <summary className="seam stateql-statement">
                <span className="overview-orb-cell">
                  <span className={`overview-orb is-${state}`} aria-hidden="true" />
                </span>
                {(item.result?.alias || item.handle) && (
                  <code className="database-history-handle">{item.result?.alias ?? item.handle}</code>
                )}
                <span className="seam-label" title={label}>
                  {item.sql ? <DatabaseSyntax text={item.sql} /> : label}
                </span>
                <span className="seam-rule" />
                <span className="stateql-who">
                  {item.origin === "user" ? "you" : item.origin === "model" ? "agent" : (item.origin ?? "retained")}
                </span>
                <span className="seam-open">
                  {item.timestamp ? <time dateTime={item.timestamp}>{displayTime(item.timestamp)}</time> : "retained"}
                  <span className="sr-only"> · {planned ? "Planned, not executed" : status.label}</span>
                </span>
              </summary>
              <div className="seam-body database-history-detail">
                <div className="database-status">
                  <strong>{item.command}</strong>
                  <span>{planned ? "Planned · not executed" : status.label}</span>
                  {item.cached && <span>Cache hit</span>}
                  <span className="spacer" />
                  <code>{item.handle}</code>
                </div>
                {item.target && (
                  <p className="database-muted">
                    Table / collection: <code>{item.target}</code>
                  </p>
                )}
                {item.sql && (
                  <>
                    <pre>
                      <DatabaseSyntax text={item.sql} />
                    </pre>
                    <button className="text-button" type="button" onClick={() => onOpen(item.sql!)}>
                      Open in editor
                    </button>
                  </>
                )}
                {item.errorCode && (
                  <p className="database-notice" role="status">
                    {item.errorCode}
                  </p>
                )}
                {item.result && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onResult(item.result!.handle, item.result!.rows)}>
                    Open {item.result.rows.toLocaleString()} stored rows
                  </button>
                )}
                {item.operation && (
                  <button className="text-button" type="button" onClick={() => onReceipt(item.operation!.handle)}>
                    Inspect receipt · {item.operation.status}
                  </button>
                )}
              </div>
            </details>
          );
        })}
        {!items.length && (
          <div className="database-empty">
            <strong>No matching activity</strong>
            <p>Queries and writes in this session appear here.</p>
          </div>
        )}
      </div>
      <footer className="database-status">
        <span>
          {items.length} recent entries{!showInternal ? " · Internal activity hidden" : ""}
        </span>
        <span className="spacer" />
        <button type="button" className="text-button" disabled={!current} onClick={() => setPage(current - 1)}>
          Previous
        </button>
        <span>
          {current + 1} / {Math.max(1, Math.ceil(items.length / 25))}
        </span>
        <button
          type="button"
          className="text-button"
          disabled={(current + 1) * 25 >= items.length}
          onClick={() => setPage(current + 1)}>
          Next
        </button>
      </footer>
    </div>
  );
}
