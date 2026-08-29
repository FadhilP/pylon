import { IconLibrary, IconX } from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { RELEASES } from "./changelog";

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [release, setRelease] = useState(RELEASES[0]!);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled])",
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

  const closeBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="changelog-backdrop" onMouseDown={closeBackdrop}>
      <div
        ref={dialogRef}
        className="changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-dialog-title"
        onKeyDown={onKeyDown}
      >
        <header>
          <div>
            <IconLibrary size={18} />
            <strong id="changelog-dialog-title">Changelog</strong>
          </div>
          <button
            data-autofocus
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close changelog"
          >
            <IconX size={17} />
          </button>
        </header>
        <div className="changelog-layout">
          <nav className="changelog-versions" aria-label="Versions">
            <span>Releases</span>
            {RELEASES.map((item, index) => (
              <button
                key={item.version}
                className={
                  item.version === release.version ? "is-active" : undefined
                }
                type="button"
                aria-current={
                  item.version === release.version ? "true" : undefined
                }
                onClick={() => setRelease(item)}
              >
                <strong>v{item.version}</strong>
                <small>{index === 0 ? "Latest" : item.date}</small>
              </button>
            ))}
          </nav>
          <article
            className="changelog-release"
            aria-live="polite"
            aria-labelledby="changelog-release-title"
          >
            <div className="changelog-meta">
              <span>v{release.version}</span>
              <span>{release.date}</span>
            </div>
            <h2 id="changelog-release-title">{release.title}</h2>
            <p>{release.summary}</p>
            <section>
              <h3>Updated</h3>
              <ul>
                {release.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          </article>
        </div>
      </div>
    </div>
  );
}
