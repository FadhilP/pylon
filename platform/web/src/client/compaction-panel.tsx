import { IconChevronDown, IconFileText, IconX } from "@tabler/icons-react";
import { formatCompactNumber } from "../shared/format";
import type {
  CompactionDisplayReadModel,
  CompactionDisplaySourceReadModel,
  MessageReadModel,
} from "../shared/protocol/events";
import { MarkdownContent } from "./conversation-panel";

export function CompactionPanel({
  message,
  onClose,
}: {
  message: MessageReadModel;
  onClose: () => void;
}) {
  const compaction = message.compaction;
  if (!compaction) return null;
  const display = compaction.display;
  const timestamp = message.createdAt ? new Date(message.createdAt) : undefined;
  const validTimestamp =
    timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : undefined;
  const hasSourceDetails = Boolean(
    display &&
    (display.records.length ||
      display.failedTools.length ||
      display.toolResults.length ||
      display.history.modified.length ||
      display.history.read.length),
  );
  const hasMetadata = Boolean(validTimestamp || message.entryId);

  return (
    <aside
      id="compaction-panel"
      className="inspector compaction-panel is-open"
      aria-labelledby="compaction-title"
    >
      <header>
        <div>
          <IconFileText size={18} />
          <strong id="compaction-title">Compaction details</strong>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close compaction details"
        >
          <IconX size={17} />
        </button>
      </header>
      <div className="compaction-panel-body">
        <dl className="compaction-panel-facts">
          {compaction.contextBeforeTokens !== undefined && (
            <div>
              <dt>Context before</dt>
              <dd>
                ~{formatCompactNumber(compaction.contextBeforeTokens)} tokens
              </dd>
            </div>
          )}
          <div>
            <dt>Context after</dt>
            <dd>
              ~{formatCompactNumber(compaction.contextAfterTokens)} tokens
            </dd>
          </div>
          {compaction.sourceEntryCount !== undefined && (
            <div>
              <dt>Source entries</dt>
              <dd>{compaction.sourceEntryCount.toLocaleString()}</dd>
            </div>
          )}
        </dl>

        <section
          className="compaction-panel-section"
          aria-labelledby="compacted-context-title"
        >
          <h2 id="compacted-context-title">Compacted context</h2>
          <MarkdownContent text={message.text} />
        </section>

        {display && hasSourceDetails && (
          <section
            className="compaction-panel-section"
            aria-labelledby="compaction-sources-title"
          >
            <h2 id="compaction-sources-title">Available source details</h2>
            <div className="compaction-display">
              {display.records.map((record, index) => (
                <article
                  className={`compaction-record is-${record.role}`}
                  key={`${record.sourceEntryId}:${record.role}:${index}`}
                >
                  <header>
                    <strong>
                      {record.role === "user" ? "User" : "Assistant"}
                    </strong>
                    <code title={record.sourceEntryId}>
                      {record.sourceEntryId}
                    </code>
                  </header>
                  <pre>{record.text}</pre>
                </article>
              ))}
              <CompactionToolGroup
                title="Failed tool calls"
                records={display.failedTools}
                failed
              />
              <CompactionToolGroup
                title="Tool results"
                records={display.toolResults}
              />
              <CompactionFileActivity history={display.history} />
            </div>
          </section>
        )}

        {hasMetadata && (
          <details className="compaction-panel-metadata">
            <summary>
              <strong>Metadata</strong>
              <IconChevronDown size={14} aria-hidden="true" />
            </summary>
            <dl>
              {validTimestamp && (
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={message.createdAt}>
                      {validTimestamp.toLocaleString()}
                    </time>
                  </dd>
                </div>
              )}
              {message.entryId && (
                <div>
                  <dt>Entry</dt>
                  <dd>
                    <code>{message.entryId}</code>
                  </dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </div>
    </aside>
  );
}

function CompactionToolGroup({
  title,
  records,
  failed = false,
}: {
  title: string;
  records: CompactionDisplaySourceReadModel[];
  failed?: boolean;
}) {
  if (!records.length) return null;
  return (
    <details className={`compaction-tool-group${failed ? " is-failed" : ""}`}>
      <summary>
        <strong>
          {title} ({records.length})
        </strong>
        <IconChevronDown size={14} aria-hidden="true" />
      </summary>
      <div>
        {records.map((record, index) => (
          <article key={`${record.sourceEntryId}:${index}`}>
            <code title={record.sourceEntryId}>{record.sourceEntryId}</code>
            <pre>{record.text}</pre>
          </article>
        ))}
      </div>
    </details>
  );
}

function CompactionFileActivity({
  history,
}: {
  history: CompactionDisplayReadModel["history"];
}) {
  const items = [
    ...history.modified.map((record) => ({ ...record, label: "Modified" })),
    ...history.read.map((record) => ({ ...record, label: "Read" })),
  ];
  if (!items.length) return null;
  return (
    <section className="compaction-file-activity">
      <strong>Observed file activity</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.label}:${item.path}:${item.sourceEntryId ?? index}`}>
            <span>{item.label}</span>
            <code title={item.path}>{item.path}</code>
            {item.sourceEntryId && (
              <small title={item.sourceEntryId}>
                Entry {item.sourceEntryId}
              </small>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
