import { IconLoader2, IconX } from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

interface ActionDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  danger?: boolean;
  inputLabel?: string;
  initialValue?: string;
  multiline?: boolean;
  maxLength?: number;
  allowEmpty?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function ActionDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  danger = false,
  inputLabel,
  initialValue = "",
  multiline = false,
  maxLength = 200,
  allowEmpty = false,
  onCancel,
  onConfirm,
}: ActionDialogProps) {
  const [value, setValue] = useState(initialValue);
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleId = "action-dialog-title";
  const descriptionId = "action-dialog-description";
  const valid = !inputLabel || allowEmpty || Boolean(value.trim());

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current
      ?.querySelector<HTMLElement>(
        inputLabel ? "[data-action-input]" : "[data-autofocus]",
      )
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [inputLabel]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
    );
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy) onConfirm(value);
  };
  const closeBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  };

  return (
    <div
      className="edit-confirm-backdrop action-dialog-backdrop"
      onMouseDown={closeBackdrop}
    >
      <form
        ref={dialogRef}
        className="edit-confirm-dialog action-dialog"
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        onSubmit={submit}
      >
        <header>
          <strong id={titleId}>{title}</strong>
          <button
            className="icon-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </header>
        <div>
          <p id={descriptionId}>{description}</p>
          {inputLabel && (
            <label className="action-dialog-field">
              {inputLabel}
              {multiline ? (
                <textarea
                  data-action-input
                  value={value}
                  maxLength={maxLength}
                  disabled={busy}
                  onChange={(event) => setValue(event.target.value)}
                />
              ) : (
                <input
                  data-action-input
                  value={value}
                  maxLength={maxLength}
                  disabled={busy}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
              {multiline && <small>Leave blank to disable.</small>}
            </label>
          )}
        </div>
        <footer>
          <button
            data-autofocus={!inputLabel ? "" : undefined}
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={`${danger ? "danger-button" : "primary-button"} action-confirm-button`}
            type="submit"
            disabled={!valid || busy}
            aria-busy={busy}
          >
            {busy && <IconLoader2 className="feedback-spinner" size={14} />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
