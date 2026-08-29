import { useEffect, useRef, useState, type ReactNode } from "react";

export function AnimatedDetails({
  className,
  summary,
  children,
  onExpand,
}: {
  className: string;
  summary: ReactNode;
  children: ReactNode;
  onExpand?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const toggle = () => {
    window.clearTimeout(closeTimer.current);
    if (expanded) {
      setExpanded(false);
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : 160;
      closeTimer.current = window.setTimeout(() => setOpen(false), delay);
      return;
    }
    onExpand?.();
    setOpen(true);
    requestAnimationFrame(() => setExpanded(true));
  };

  return (
    <details
      className={`${className}${expanded ? " is-expanded" : ""}`}
      open={open}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
      >
        {summary}
      </summary>
      <div className="aggregate-disclosure-motion">
        <div>{children}</div>
      </div>
    </details>
  );
}
