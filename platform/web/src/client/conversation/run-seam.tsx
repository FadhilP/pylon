/* Inline markers for compaction, retries, and failed requests. */
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { OverviewOrb, type OverviewState } from "../ui/overview-primitives";

function SeamContent({ state, label, value }: { state: OverviewState; label: string; value?: ReactNode }) {
  return (
    <>
      <OverviewOrb state={state} label={label} />
      <span className="seam-label">{label}</span>
      <span className="seam-rule" aria-hidden="true" />
      {value !== undefined && <span className="seam-value mono">{value}</span>}
    </>
  );
}

/** Status-only event marker. */
export function RunSeam({ state, label, value }: { state: OverviewState; label: string; value?: ReactNode }) {
  return (
    <div className={`seam is-${state}`} role="status" aria-live="polite">
      <SeamContent state={state} label={label} value={value} />
    </div>
  );
}

/** Event marker that opens details elsewhere. */
export function SeamLink({
  state,
  label,
  value,
  action,
  onClick,
}: {
  state: OverviewState;
  label: string;
  value?: ReactNode;
  action: string;
  onClick: () => void;
}) {
  return (
    <button className={`seam is-${state}`} type="button" onClick={onClick}>
      <SeamContent state={state} label={label} value={value} />
      <span className="seam-open">
        {action}
        <IconChevronRight size={13} aria-hidden="true" />
      </span>
    </button>
  );
}

/** Expand details inline, with actions below and an optional external opener beside the summary. */
export function SeamDisclosure({
  state,
  label,
  value,
  action,
  actions,
  trailing,
  children,
}: {
  state: OverviewState;
  label: string;
  value?: ReactNode;
  /** Omit when the seam's own label already names what opens. */
  action?: string;
  actions?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="seam-block">
      <summary className={`seam is-${state}${trailing ? " has-pair" : ""}`}>
        <SeamContent state={state} label={label} value={value} />
        <span className="seam-open">
          {action}
          <IconChevronDown size={13} className="seam-chevron" aria-hidden="true" />
        </span>
        {trailing && (
          <>
            <span className="seam-sep" aria-hidden="true" />
            {trailing}
          </>
        )}
      </summary>
      <div className="seam-body">{children}</div>
      {actions && <div className="seam-actions">{actions}</div>}
    </details>
  );
}
