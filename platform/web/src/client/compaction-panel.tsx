import { IconChevronDown, IconFileText, IconX } from "@tabler/icons-react";
import { formatCompactNumber } from "../shared/format";
import type {
  CompactionDisplayReadModel,
  CompactionDisplaySourceReadModel,
  MessageReadModel,
} from "../shared/protocol/events";
import { MarkdownContent } from "./conversation-panel";
import { LedBar, OverviewOrb, type OverviewState } from "./overview-primitives";

export function CompactionPanel({
  message,
  contextLimit,
  onClose,
}: {
  message: MessageReadModel;
  contextLimit?: number;
  onClose: () => void;
}) {
  const compaction = message.compaction;
  if (!compaction) return null;
  const display = compaction.display;
  const timestamp = message.createdAt ? new Date(message.createdAt) : undefined;
  const validTimestamp = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : undefined;
  const before = compaction.contextBeforeTokens;
  const ratio = before
    ? { label: "Kept", percent: Math.min(100, Math.round((compaction.contextAfterTokens / before) * 100)) }
    : contextLimit
      ? { label: "Window", percent: Math.min(100, Math.round((compaction.contextAfterTokens / contextLimit) * 100)) }
      : undefined;
  const folded = display ? foldedGroups(display) : [];
  const hasMetadata = Boolean(validTimestamp || message.entryId);

  return (
    <aside id="compaction-panel" className="inspector compaction-panel is-open" aria-labelledby="compaction-title">
      <header>
        <div>
          <IconFileText size={18} />
          <span className="section-kicker" id="compaction-title">
            Compaction
          </span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close compaction details">
          <IconX size={17} />
        </button>
      </header>
      <div className="compaction-panel-body">
        <div className="session-tool-summary">
          <div className="session-tool-call-total is-cost">
            <small>Context after</small>
            <strong className="mono">{formatCompactNumber(compaction.contextAfterTokens)}</strong>
            <span>{before === undefined ? "tokens" : `was ${formatCompactNumber(before)}`}</span>
          </div>
          <div className="session-token-composition">
            {ratio && (
              <>
                <div>
                  <small>{ratio.label}</small>
                  <strong className="mono">{ratio.percent}%</strong>
                </div>
                <LedBar a={ratio.percent} cells={26} label={`${ratio.percent}% ${ratio.label.toLowerCase()}`} />
              </>
            )}
            <div className="session-token-key">
              <span>
                <strong>Folded</strong>{" "}
                {compaction.sourceEntryCount === undefined
                  ? "—"
                  : `${compaction.sourceEntryCount.toLocaleString()} entries`}
              </span>
              {validTimestamp && (
                <span>
                  <strong>At</strong> {validTimestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>
        </div>

        <details className="inspector-section compaction-kept">
          <summary>
            <span>
              <strong>Kept in context</strong>
              <small>the summary the model now reads</small>
            </span>
            <IconChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="compaction-kept-body">
            <MarkdownContent text={message.text} />
          </div>
        </details>

        {folded.length > 0 && (
          <section className="compaction-folded" aria-labelledby="compaction-folded-title">
            <header>
              <strong id="compaction-folded-title">Folded in</strong>
              <span>what the summary replaced</span>
            </header>
            {folded.map(group => (
              <FoldedGroup key={group.label} group={group} />
            ))}
          </section>
        )}

        {hasMetadata && (
          <details className="inspector-section compaction-source">
            <summary>
              <span>
                <strong>Source entry</strong>
                {message.entryId && <small>{message.entryId}</small>}
              </span>
              <IconChevronDown size={14} aria-hidden="true" />
            </summary>
            <dl>
              {validTimestamp && (
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={message.createdAt}>{validTimestamp.toLocaleString()}</time>
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

type FoldedGroup = {
  label: string;
  state: OverviewState;
  detail: string;
  count: number;
  records: CompactionDisplaySourceReadModel[];
};

function foldedGroups(display: CompactionDisplayReadModel): FoldedGroup[] {
  const prompts = display.records.filter(record => record.role === "user");
  const replies = display.records.filter(record => record.role === "assistant");
  const files = [
    ...display.history.modified.map(record => ({ ...record, label: "Modified" })),
    ...display.history.read.map(record => ({ ...record, label: "Read" })),
  ];
  const groups: FoldedGroup[] = [
    { label: "Your messages", state: "set", detail: "prompts", count: prompts.length, records: prompts },
    {
      label: "Assistant replies",
      state: "neutral",
      detail: "summarised above",
      count: replies.length,
      records: replies,
    },
    {
      label: "Tool results",
      state: "done",
      detail: "returned to the model",
      count: display.toolResults.length,
      records: display.toolResults,
    },
    {
      label: "Failed tool calls",
      state: "failed",
      detail: "errors and denials",
      count: display.failedTools.length,
      records: display.failedTools,
    },
    {
      label: "Files touched",
      state: "attention",
      detail: files
        .slice(0, 3)
        .map(file => file.path.split("/").at(-1))
        .join(", "),
      count: files.length,
      records: files.map(file => ({
        sourceEntryId: file.sourceEntryId ?? file.path,
        text: `${file.label} ${file.path}`,
      })),
    },
  ];
  return groups.filter(group => group.count > 0);
}

function FoldedGroup({ group }: { group: FoldedGroup }) {
  return (
    <details className="fold">
      <summary>
        <OverviewOrb state={group.state} label={group.label} />
        <span>
          <strong>{group.label}</strong>
          <small>{group.detail}</small>
        </span>
        <span className="fold-count mono">{group.count.toLocaleString()}</span>
      </summary>
      <div className="fold-body">
        {group.records.map((record, index) => (
          <article key={`${record.sourceEntryId}:${index}`}>
            <code title={record.sourceEntryId}>{record.sourceEntryId}</code>
            <pre>{record.text}</pre>
          </article>
        ))}
      </div>
    </details>
  );
}
