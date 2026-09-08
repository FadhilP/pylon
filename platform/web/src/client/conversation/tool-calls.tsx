/* Tool-call renderer shared by the transcript and agents drawer. */
import { IconChevronDown } from "@tabler/icons-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatToolDuration } from "../ui/session-format";
import {
  aggregateToolCallTiming,
  toolCallGroupStatus,
  toolCallNames,
  toolCallTrackTicks,
  type ToolCallStatus,
  type ToolCallView,
} from "./tool-call-model";
import { AnimatedDetails } from "../ui/animated-details";
import { OverviewOrb, type OverviewState } from "../ui/overview-primitives";

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
  const inputPreview = useMemo(() => call.input?.replace(/\s+/g, " ").trim(), [call.input]);
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
      <ToolCallOutput input={call.input} output={call.output} status={call.status} />
    </details>
  );
}

// Keep closed details mounted for browser find and disclosure state, but do not
// reconcile their unchanged large text bodies on every stream/duration update.
const ToolCallOutput = memo(function ToolCallOutput({ input, output, status }: Pick<ToolCallView, "input" | "output" | "status">) {
  return <div className="tool-call-io">
    <section><small>Arguments</small><pre>{input || "No input"}</pre></section>
    <section><small>Result</small><pre className={status === "failed" ? "is-error" : undefined}>
      {output || (status === "running" ? "Waiting for output…" : "No output")}
    </pre></section>
  </div>;
});

export function ToolCallList({ calls }: { calls: ToolCallView[] }) {
  return (
    <div className="tool-call-list">
      {calls.map(call => (
        <ToolCallRow key={call.key} call={call} />
      ))}
    </div>
  );
}

export function ToolCallTrack({
  calls,
  slots,
  variant = "group",
}: {
  calls: ToolCallView[];
  slots?: number | "auto";
  variant?: "lane" | "group";
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const [measuredSlots, setMeasuredSlots] = useState(32);
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (slots !== "auto" || !track) return;
    const update = () => {
      const tickWidth = track.querySelector("i")?.getBoundingClientRect().width ?? 3;
      const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0;
      const capacity = Math.max(1, Math.floor((track.clientWidth + gap) / (tickWidth + gap)));
      setMeasuredSlots(current => (current === capacity ? current : capacity));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(track);
    return () => observer.disconnect();
  }, [slots]);
  const resolvedSlots = slots === "auto" ? measuredSlots : slots;
  const ticks = toolCallTrackTicks(calls, resolvedSlots);
  const emptySlots = resolvedSlots === undefined ? 0 : Math.max(0, resolvedSlots - ticks.length);
  return (
    <span ref={trackRef} className={variant === "lane" ? "agent-lane-track" : "tool-call-track"} aria-hidden="true">
      {ticks.map(tick => (
        <i
          key={tick.key}
          className={
            tick.status === "running"
              ? "is-live"
              : tick.status === "failed"
                ? "is-error"
                : variant === "lane"
                  ? "is-call"
                  : undefined
          }
          style={{ height: `${tick.height}px` }}
        />
      ))}
      {Array.from({ length: emptySlots }, (_, index) => (
        <i key={`empty-${index}`} />
      ))}
    </span>
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
          <ToolCallTrack calls={calls} />
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
