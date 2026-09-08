import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  changelogSpanDays,
  findNotes,
  groupReleasesByWeek,
  noteKind,
  releaseMatches,
  splitMatch,
  tallyNotes,
  type ChangelogRelease,
} from "../src/client/settings/changelog.ts";

/* Read, not imported: tsconfig.server.json covers test without resolveJsonModule. */
const RELEASES = JSON.parse(
  readFileSync(new URL("../../../CHANGELOG.json", import.meta.url), "utf8"),
) as ChangelogRelease[];

const release = (date: string, notes: string[] = ["Added a thing."]): ChangelogRelease => ({
  version: "1.0.0",
  date,
  title: "Title",
  summary: "Summary",
  notes,
});

test("kinds follow the leading verb", () => {
  assert.equal(noteKind("Added a branch picker to Local sessions."), "added");
  assert.equal(noteKind("Introduced a setting."), "added");
  assert.equal(noteKind("Removed a stale assertion."), "removed");
  assert.equal(noteKind("Fixed composer session action menus."), "changed");
  assert.equal(noteKind("Raised the compaction review output default."), "changed");
  assert.equal(noteKind("Addedness is not a word."), "changed");
});

test("tally drops empty buckets and keeps a stable order", () => {
  const notes = ["Added one.", "Added two.", "Moved three.", "Removed four."];
  assert.deepEqual(tallyNotes(notes), [
    { kind: "added", count: 2 },
    { kind: "changed", count: 1 },
    { kind: "removed", count: 1 },
  ]);
  assert.deepEqual(tallyNotes(["Moved one."]), [{ kind: "changed", count: 1 }]);
  assert.deepEqual(tallyNotes([]), []);
});

test("releases group into Sunday-start weeks, in list order", () => {
  const weeks = groupReleasesByWeek([
    release("Sep 4, 2026"),
    release("Sep 3, 2026"),
    release("Aug 31, 2026"),
    release("Aug 30, 2026"),
    release("Aug 29, 2026"),
  ]);
  assert.deepEqual(
    weeks.map(week => [week.label, week.releases.length]),
    [
      ["Aug 30", 4],
      ["Aug 23", 1],
    ],
  );
});

test("a week label is fixed, not locale- or zone-dependent", () => {
  // Sep 4 2026 is a Friday; its week starts Sunday Aug 30 in every zone.
  const [week] = groupReleasesByWeek([release("Sep 4, 2026")]);
  assert.equal(week?.label, "Aug 30");
  assert.equal(week?.key, "2026-08-30");
});

test("an unparseable date still appears, under its own heading", () => {
  const weeks = groupReleasesByWeek([release("sometime")]);
  assert.deepEqual(
    weeks.map(week => week.label),
    ["sometime"],
  );
  assert.equal(weeks[0]?.releases.length, 1);
});

test("the packaged history groups without losing a release", () => {
  const weeks = groupReleasesByWeek(RELEASES);
  assert.equal(
    weeks.reduce((total, week) => total + week.releases.length, 0),
    RELEASES.length,
  );
  assert.ok(weeks.length > 1 && weeks.length < RELEASES.length, "weeks should be a coarser grain than releases");
  assert.ok(changelogSpanDays(RELEASES) > 0);
});

test("search covers version, title, summary and notes", () => {
  const item = release("Sep 4, 2026", ["Added a branch picker."]);
  assert.ok(releaseMatches(item, "1.0.0"));
  assert.ok(releaseMatches(item, "TITLE"));
  assert.ok(releaseMatches(item, "summary"));
  assert.ok(releaseMatches(item, "branch picker"));
  assert.ok(!releaseMatches(item, "nothing here"));
});

test("a search answers with notes, each carrying its version", () => {
  const hits = findNotes(RELEASES, "branch picker");
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.ok(hit.note.toLowerCase().includes("branch picker"));
    assert.ok(RELEASES.some(item => item.version === hit.version && item.notes.includes(hit.note)));
  }
});

test("splitMatch marks every occurrence and rebuilds the original text", () => {
  const segments = splitMatch("Added and added again", "added");
  assert.equal(segments.map(segment => segment.text).join(""), "Added and added again");
  assert.deepEqual(
    segments.filter(segment => segment.match).map(segment => segment.text),
    ["Added", "added"],
  );
  assert.deepEqual(splitMatch("untouched", ""), [{ text: "untouched", match: false }]);
});
