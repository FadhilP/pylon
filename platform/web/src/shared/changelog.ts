export type ChangelogRelease = {
  version: string;
  date: string;
  title: string;
  summary: string;
  notes: string[];
};

export type NoteKind = "added" | "changed" | "removed";

const ADDED =
  /^(Added|Introduced|Expanded|Extended|Allowed|Enabled|Included|Shipped|Exposed|Gave|Brought|Integrated|Published|Connected|Linked|Displayed|Taught|Shared|Started|Recorded|Tracked|Enriched)\b/;
const REMOVED = /^(Removed|Trimmed|Dropped|Deprecated|Deleted|Retired)\b/;

export const NOTE_KINDS: NoteKind[] = ["added", "changed", "removed"];

export const NOTE_ORB: Record<NoteKind, string> = {
  added: "is-done",
  changed: "is-attention",
  removed: "is-failed",
};

export function noteKind(note: string): NoteKind {
  if (ADDED.test(note)) return "added";
  if (REMOVED.test(note)) return "removed";
  return "changed";
}

export function tallyNotes(notes: string[]): { kind: NoteKind; count: number }[] {
  return NOTE_KINDS.map(kind => ({ kind, count: notes.filter(note => noteKind(note) === kind).length })).filter(
    entry => entry.count > 0,
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Parsed in UTC from a fixed table, not Date.parse and toLocaleDateString: a
   week must not shift a day across time zones, nor the label shape by locale. */
function parseReleaseDate(date: string): Date | null {
  const match = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(date.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
}

function weekStart(date: Date): Date {
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return start;
}

export type ChangelogWeek = { key: string; label: string; releases: ChangelogRelease[] };

export function groupReleasesByWeek(releases: ChangelogRelease[]): ChangelogWeek[] {
  const weeks: ChangelogWeek[] = [];
  for (const release of releases) {
    const parsed = parseReleaseDate(release.date);
    const start = parsed ? weekStart(parsed) : null;
    const key = start ? start.toISOString().slice(0, 10) : release.date;
    const label = start ? `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}` : release.date;
    const last = weeks[weeks.length - 1];
    if (last?.key === key) last.releases.push(release);
    else weeks.push({ key, label, releases: [release] });
  }
  return weeks;
}

export function changelogSpanDays(releases: ChangelogRelease[]): number {
  const times = releases.map(release => parseReleaseDate(release.date)?.getTime()).filter(time => time !== undefined);
  if (times.length < 2) return 0;
  return Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000);
}

export function releaseMatches(release: ChangelogRelease, query: string): boolean {
  const needle = query.toLowerCase();
  return [release.version, release.title, release.summary, ...release.notes].some(field =>
    field.toLowerCase().includes(needle),
  );
}

export type ChangelogHit = { version: string; date: string; note: string };

export function findNotes(releases: ChangelogRelease[], query: string): ChangelogHit[] {
  const needle = query.toLowerCase();
  return releases.flatMap(release =>
    release.notes
      .filter(note => note.toLowerCase().includes(needle))
      .map(note => ({ version: release.version, date: release.date, note })),
  );
}

export function splitMatch(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.toLowerCase();
  if (!needle) return [{ text, match: false }];
  const segments: { text: string; match: boolean }[] = [];
  const haystack = text.toLowerCase();
  let cursor = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, cursor)) {
    if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
