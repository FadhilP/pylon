import { IconLibrary, IconSearch, IconX } from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import RELEASES from "../../../../../CHANGELOG.json";
import {
  changelogSpanDays,
  findNotes,
  groupReleasesByWeek,
  noteKind,
  NOTE_ORB,
  releaseMatches,
  splitMatch,
  tallyNotes,
  type ChangelogRelease,
} from "./changelog";

const releases = RELEASES as ChangelogRelease[];
const spanDays = changelogSpanDays(releases);
const totalNotes = releases.reduce((total, release) => total + release.notes.length, 0);

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitMatch(text, query).map((segment, index) =>
        segment.match ? <mark key={index}>{segment.text}</mark> : segment.text,
      )}
    </>
  );
}

function NoteOrb({ note }: { note: string }) {
  const kind = noteKind(note);
  return <i className={`overview-orb ${NOTE_ORB[kind]}`} role="img" aria-label={kind} title={kind} />;
}

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [release, setRelease] = useState(releases[0]!);
  const [query, setQuery] = useState("");
  const search = query.trim();

  const shown = useMemo(
    () => (search ? releases.filter(item => releaseMatches(item, search)) : releases),
    [search],
  );
  const weeks = useMemo(() => groupReleasesByWeek(shown), [shown]);
  const hits = useMemo(() => (search ? findNotes(releases, search) : []), [search]);
  const tally = tallyNotes(release.notes);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (search) setQuery("");
      else onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input");
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
        onKeyDown={onKeyDown}>
        <header>
          <div>
            <IconLibrary size={18} />
            <strong id="changelog-dialog-title">Changelog</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close changelog">
            <IconX size={17} />
          </button>
        </header>
        <div className="changelog-layout">
          <nav className="changelog-versions" aria-label="Releases">
            <label className="changelog-search">
              <IconSearch size={14} />
              <input
                data-autofocus
                type="search"
                value={query}
                placeholder={`Search ${totalNotes} notes`}
                aria-label="Search the changelog"
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <div className="changelog-version-list">
              {weeks.map(week => (
                <div key={week.key} className="changelog-week-group">
                  <h3 className="changelog-week">
                    Week of <b>{week.label}</b>
                  </h3>
                  {week.releases.map(item => (
                    <button
                      key={item.version}
                      className={item.version === release.version ? "is-active" : undefined}
                      type="button"
                      aria-current={item.version === release.version ? "true" : undefined}
                      onClick={() => setRelease(item)}>
                      <span className="changelog-version-title">
                        <Marked text={item.title} query={search} />
                      </span>
                      <small>v{item.version}</small>
                      <small className="changelog-version-sub">
                        {item.date} · {item.notes.length} note{item.notes.length === 1 ? "" : "s"}
                      </small>
                    </button>
                  ))}
                </div>
              ))}
              {weeks.length === 0 && <p className="changelog-empty">No release matches that.</p>}
            </div>
            <div className="changelog-versions-foot">
              <span>
                {shown.length} of {releases.length}
              </span>
              <span>
                {releases.length} releases{spanDays > 0 ? ` · ${spanDays} days` : ""}
              </span>
            </div>
          </nav>
          {search ? (
            <article className="changelog-release" aria-live="polite" aria-label="Search results">
              <p className="changelog-hit-count">
                {hits.length} note{hits.length === 1 ? "" : "s"} match “{search}”, across{" "}
                {new Set(hits.map(hit => hit.version)).size} releases.
              </p>
              <ul className="changelog-hits">
                {hits.map(hit => (
                  <li key={`${hit.version}-${hit.note}`}>
                    <NoteOrb note={hit.note} />
                    <span>
                      <Marked text={hit.note} query={search} />
                    </span>
                    <small>v{hit.version}</small>
                  </li>
                ))}
              </ul>
              {hits.length === 0 && <p className="changelog-empty">Nothing in {totalNotes} notes matches that.</p>}
            </article>
          ) : (
            <article className="changelog-release" aria-live="polite" aria-labelledby="changelog-release-title">
              <div className="changelog-meta">
                <span>v{release.version}</span>
                <span>{release.date}</span>
                <span className="changelog-tallies">
                  {tally.map(entry => (
                    <span key={entry.kind} className="changelog-tally">
                      <i className={`overview-orb ${NOTE_ORB[entry.kind]}`} aria-hidden="true" />
                      {entry.count} {entry.kind}
                    </span>
                  ))}
                </span>
              </div>
              <h2 id="changelog-release-title">{release.title}</h2>
              <p>{release.summary}</p>
              <ul className="changelog-notes">
                {release.notes.map(note => (
                  <li key={note}>
                    <NoteOrb note={note} />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
