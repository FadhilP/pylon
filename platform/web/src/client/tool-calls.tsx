/* The one tool-call renderer, shared by the transcript and the agents drawer.
   A group is a header row, its calls are rows on the same 22px orb rail, and
   arguments and result share one inset panel — state lives on the orbs. */
import { IconChevronDown } from "@tabler/icons-react";
import { formatToolDuration } from "../shared/format";
import {
  aggregateToolCallTiming,
  toolCallGroupStatus,
  toolCallNames,
  type ToolCallStatus,
  type ToolCallView,
} from "../shared/tool-calls";
import { AnimatedDetails } from "./animated-details";
import { OverviewOrb, type OverviewState } from "./overview-primitives";

const ORB_STATE: Record<ToolCallStatus, OverviewState> = {
  running: "running",
  completed: "done",
  failed: "failed",
  attention: "attention",
};

function ToolCallDuration({ status, durationMs }: { status: ToolCallStatus; durationMs?: number }) {
  if (durationMs === undefined) return <>{status}</>;
  return (
    <>
      <span className="sr-only">{status}, </span>
      <time dateTime={`PT${durationMs / 1_000}S`}>{formatToolDuration(durationMs)}</time>
    </>
  );
}

export function ToolCallRow({ call }: { call: ToolCallView }) {
  const inputPreview = call.input?.replace(/\s+/g, " ").trim();
  return (
    <details className={`tool-call is-${call.status}`}>
      <summary>
        <OverviewOrb state={ORB_STATE[call.status]} label={call.status} />
        <span className="tool-call-copy">
          <strong>{call.name}</strong>
          {inputPreview && <code>{inputPreview}</code>}
        </span>
        <span className="tool-call-time">
          <ToolCallDuration status={call.status} durationMs={call.durationMs} />
        </span>
      </summary>
      <div className="tool-call-io">
        <section>
          <small>Arguments</small>
          <pre>{call.input || "No input"}</pre>
        </section>
        <section>
          <small>Result</small>
          <pre className={call.status === "failed" ? "is-error" : undefined}>
            {call.output || (call.status === "running" ? "Waiting for output…" : "No output")}
          </pre>
        </section>
      </div>
    </details>
  );
}

export function ToolCallList({ calls }: { calls: ToolCallView[] }) {
  return (
    <div className="tool-call-list">
      {calls.map(call => (
        <ToolCallRow key={call.key} call={call} />
      ))}
    </div>
  );
}

export function ToolCallGroup({
  calls,
  running = false,
  onExpand,
}: {
  calls: ToolCallView[];
  running?: boolean;
  onExpand?: () => void;
}) {
  const status = toolCallGroupStatus(calls, running);
  const timing = aggregateToolCallTiming(calls);
  const timingLabel =
    timing?.status === "running"
      ? "Longest running tool duration"
      : `Latest ${timing?.status ?? "completed"} tool duration`;
  return (
    <AnimatedDetails
      className={`tool-call-group is-${status}`}
      summary={
        <>
          <OverviewOrb state={ORB_STATE[status]} label={status} />
          <span className="tool-call-group-copy">
            <strong>
              {calls.length} tool {calls.length === 1 ? "call" : "calls"}
            </strong>
            <small>{toolCallNames(calls).join(" · ")}</small>
          </span>
          {timing && (
            <time
              className={`tool-call-group-time is-${timing.status}`}
              dateTime={`PT${timing.durationMs / 1_000}S`}
              aria-label={`${timingLabel} ${formatToolDuration(timing.durationMs)}`}>
              {formatToolDuration(timing.durationMs)}
            </time>
          )}
          <IconChevronDown className="tool-call-chevron" size={13} />
        </>
      }
      onExpand={onExpand}>
      <ToolCallList calls={calls} />
    </AnimatedDetails>
  );
}
