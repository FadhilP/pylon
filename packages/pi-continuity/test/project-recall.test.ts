import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  defaultPiSessionDir,
  loadProjectRecallSessions,
  parseProjectSession,
  type ProjectSessionSource,
} from "../src/project-recall.ts";

const header = (id: string, cwd: string, version = 3) => ({
  type: "session",
  version,
  id,
  timestamp: "2025-01-01T00:00:00.000Z",
  cwd,
});
const entry = (id: string, parentId: string | null, content: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2025-01-01T00:00:01.000Z",
  message: { role: "user", content, timestamp: 1 },
});
const jsonl = (...values: any[]) =>
  `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
const info = (
  id: string,
  cwd: string,
  path: string,
  modified: string,
): SessionInfo => ({
  id,
  cwd,
  path,
  created: new Date("2025-01-01T00:00:00.000Z"),
  modified: new Date(modified),
  messageCount: 1,
  firstMessage: id,
  allMessagesText: id,
});

test("project-session parsing returns only the validated active branch", () => {
  const cwd = resolve("project-a");
  const content = jsonl(
    header("session-a", cwd),
    entry("root", null, "root"),
    entry("sibling", "root", "sibling"),
    entry("active", "root", "active"),
  );
  const branch = parseProjectSession(content, { sessionId: "session-a", cwd });
  assert.deepEqual(
    branch?.map((item) => item.id),
    ["root", "active"],
  );

  assert.equal(
    parseProjectSession(content.replace('"version":3', '"version":1'), {
      sessionId: "session-a",
      cwd,
    }),
    undefined,
  );
  assert.equal(
    parseProjectSession(content, { sessionId: "other", cwd }),
    undefined,
  );
  assert.equal(
    parseProjectSession(
      jsonl(header("session:ambiguous", cwd), entry("leaf", null, "bad id")),
      { sessionId: "session:ambiguous", cwd },
    ),
    undefined,
  );
  assert.equal(
    parseProjectSession(
      jsonl(header("session-a", cwd), entry("leaf", "missing", "bad")),
      { sessionId: "session-a", cwd },
    ),
    undefined,
  );
});

test("project-session loading stays within registered project owners and excludes the current session", async () => {
  const cwdA = resolve("project-a"),
    cwdB = resolve("project-b"),
    cwdOther = resolve("other");
  const path = (cwd: string, name: string) =>
    join(defaultPiSessionDir(cwd), `${name}.jsonl`);
  const current = info(
    "current",
    cwdA,
    path(cwdA, "current"),
    "2025-01-05T00:00:00.000Z",
  );
  const malformed = info(
    "malformed",
    cwdA,
    path(cwdA, "malformed"),
    "2025-01-04T00:00:00.000Z",
  );
  const second = info(
    "second",
    cwdB,
    path(cwdB, "second"),
    "2025-01-03T00:00:00.000Z",
  );
  const first = info(
    "first",
    cwdA,
    path(cwdA, "first"),
    "2025-01-02T00:00:00.000Z",
  );
  const outside = info(
    "outside",
    cwdA,
    resolve("outside.jsonl"),
    "2025-01-06T00:00:00.000Z",
  );
  const unrelated = info(
    "unrelated",
    cwdOther,
    path(cwdOther, "unrelated"),
    "2025-01-06T00:00:00.000Z",
  );
  const contents = new Map([
    [malformed.path, "not json\n"],
    [
      second.path,
      jsonl(header(second.id, second.cwd), entry("b", null, "second evidence")),
    ],
    [
      first.path,
      jsonl(header(first.id, first.cwd), entry("a", null, "first evidence")),
    ],
    [
      unrelated.path,
      jsonl(
        header(unrelated.id, unrelated.cwd),
        entry("x", null, "unrelated evidence"),
      ),
    ],
  ]);
  const listedCwds: string[] = [];
  const source: ProjectSessionSource = {
    async list(cwd) {
      listedCwds.push(cwd);
      if (cwd === cwdA) return [outside, current, malformed, first, first];
      if (cwd === cwdB) return [second];
      return [unrelated];
    },
    async read(path) {
      const content = contents.get(path);
      return content === undefined
        ? undefined
        : { content, bytes: Buffer.byteLength(content) };
    },
  };
  const result = await loadProjectRecallSessions(
    {
      projectOwner: "owner",
      workspaces: [
        { id: "owner", canonicalPath: cwdA, createdAt: "", lastSeenAt: "" },
        {
          id: "b",
          canonicalPath: cwdB,
          projectOwner: "owner",
          createdAt: "",
          lastSeenAt: "",
        },
        {
          id: "other",
          canonicalPath: cwdOther,
          projectOwner: "other",
          createdAt: "",
          lastSeenAt: "",
        },
      ],
      currentSessionId: current.id,
      currentSessionFile: current.path,
      currentCwd: cwdA,
    },
    source,
  );

  assert.deepEqual(new Set(listedCwds), new Set([cwdA, cwdB]));
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["second", "first"],
  );
  assert.equal(result.skipped, 2);
  assert.equal(result.truncated, false);
});
