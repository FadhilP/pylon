/* Overview prototype primitives shared by the inspector and the agents panel.
   Keep these in sync with prototypes/panel-kit.css (.orb, .orb-cell, .slabel, .bar). */
import { useEffect, useRef, useState, type ReactNode } from "react";

/** "step" is a hollow orb: a marker on a rail that carries no state of its own. */
export type OverviewState = "neutral" | "done" | "running" | "failed" | "attention" | "step" | "set";

export function LedBar({
  a,
  b = 0,
  cells = 24,
  thin = false,
  responsive = false,
  tone,
  running = false,
  label,
}: {
  a: number;
  b?: number;
  cells?: number;
  thin?: boolean;
  responsive?: boolean;
  tone?: OverviewState;
  running?: boolean;
  label?: string;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const [responsiveCells, setResponsiveCells] = useState(cells);
  useEffect(() => {
    const bar = barRef.current;
    if (!responsive || !bar || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      if (width <= 0) return;
      const next = Math.max(12, Math.min(40, Math.floor((width + 2) / 12)));
      setResponsiveCells(current => (current === next ? current : next));
    };
    update(bar.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [responsive]);
  const renderedCells = responsive ? responsiveCells : cells;
  const clamp = (value: number) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  const onA = Math.round((clamp(a) / 100) * renderedCells);
  const onB = Math.round((clamp(b) / 100) * renderedCells);
  const filled = Math.min(renderedCells, onA + onB);
  const classes = ["overview-led-bar", thin && "is-thin", tone && `tone-${tone}`, running && "is-running"]
    .filter(Boolean)
    .join(" ");
  return (
    <span ref={barRef} className={classes} aria-label={label} aria-hidden={label ? undefined : true}>
      {Array.from({ length: renderedCells }, (_, index) => (
        <i
          className={index < onA ? "is-on" : index < filled ? "is-on is-b" : running ? "is-pending" : ""}
          style={running && index >= filled ? { animationDelay: `${(index - filled) * 50}ms` } : undefined}
          key={index}
        />
      ))}
    </span>
  );
}
export function OverviewOrb({ state, label }: { state: OverviewState; label: string }) {
  return (
    <span className="overview-orb-cell">
      <i className={`overview-orb is-${state}`} aria-label={label} />
    </span>
  );
}

export function OverviewStateLabel({ state, children }: { state: OverviewState; children: ReactNode }) {
  return <span className={`overview-state-label is-${state}`}>{children}</span>;
}

export function useResponsiveUsageLedCells() {
  const listRef = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState(24);
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      if (width <= 0) return;
      const next = Math.max(12, Math.min(40, Math.round((width - 164) / 12)));
      setCells(current => (current === next ? current : next));
    };
    update(list.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  return [listRef, cells] as const;
}
