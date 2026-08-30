/* A seam is a point where the run changed shape — context compacted, a
   request retried, a request that failed. These are not messages, so they
   are not cards: each is a rule across the transcript with the state orb on
   it, the label riding the left and the consequence in mono on the right.
   In flight the rule itself carries the motion, so nothing needs a spinner. */
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { OverviewOrb, type OverviewState } from "./overview-primitives";

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

/** An event with nothing to open: the number closes the rule. */
export function RunSeam({ state, label, value }: { state: OverviewState; label: string; value?: ReactNode }) {
  return (
    <div className={`seam is-${state}`} role="status" aria-live="polite">
      <SeamContent state={state} label={label} value={value} />
    </div>
  );
}

/** An event whose detail lives elsewhere, so the affordance points away. */
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

/** An event whose detail belongs in the thread, so it opens in place.
    Actions sit under the panel rather than inside it, the way a message's
    own actions sit under the message. */
export function SeamDisclosure({
  state,
  label,
  value,
  action,
  actions,
  children,
}: {
  state: OverviewState;
  label: string;
  value?: ReactNode;
  action: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="seam-block">
      <summary className={`seam is-${state}`}>
        <SeamContent state={state} label={label} value={value} />
        <span className="seam-open">
          {action}
          <IconChevronDown size={13} className="seam-chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="seam-body">{children}</div>
      {actions && <div className="seam-actions">{actions}</div>}
    </details>
  );
}
