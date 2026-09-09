import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Panel documentation behind an (i), overlaid instead of holding a row. */
export function AboutPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="about" ref={wrapper}>
      <button
        type="button"
        className="about-button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(value => !value)}>
        <IconInfoCircle size={15} />
      </button>
      {open && (
        <div className="about-sheet" role="note" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
