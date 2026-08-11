import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLineEditTools } from "../src/line-edit.ts";

function tools() {
  const registered = new Map<string, any>();
  registerLineEditTools({ registerTool: (tool: any) => registered.set(tool.name, tool) } as any);
  return registered;
}

async function invoke(tool: any, params: any, cwd: string) {
  return tool.execute("call", params, undefined, undefined, { cwd });
}

function revision(result: any): string {
  const value = result.details?.lineEdit?.revision ?? result.details?.revision;
  assert.match(value, /^[0-9a-f]{12,64}$/);
  return value;
}

test("numbered reads issue compact revisions and reject unseen or stale edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-line-edit-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, "one\ntwo\nthree\n");
    const registered = tools();
    const read = registered.get("read");
    const edit = registered.get("edit");
    const first = await invoke(read, { path: "sample.txt", offset: 1, limit: 2 }, cwd);
    assert.match(first.content[0].text, /^\[sample\.txt#[0-9a-f]{12}\]\n1:one\n2:two/);
    assert.match(first.content[0].text, /2 more lines/);
    const tag = revision(first);

    await assert.rejects(
      invoke(edit, {
        path: "sample.txt", revision: tag,
        edits: [{ operation: "replace", startLine: 3, endLine: 3, newText: "THREE" }],
      }, cwd),
      /Lines 3-3 were not displayed/,
    );
    assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\n");

    await writeFile(path, "external\ntwo\nthree\n");
    await assert.rejects(
      invoke(edit, {
        path: "sample.txt", revision: tag,
        edits: [{ operation: "replace", startLine: 2, endLine: 2, newText: "TWO" }],
      }, cwd),
      /File changed after revision/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("one edit call resolves disjoint operations against the original snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-line-batch-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, "one\ntwo\nthree\n");
    const registered = tools();
    const read = registered.get("read");
    const edit = registered.get("edit");
    const before = await invoke(read, { path: "sample.txt" }, cwd);
    const result = await invoke(edit, {
      path: "sample.txt",
      revision: revision(before),
      edits: [
        { operation: "insert_after", line: 3, newText: "four" },
        { operation: "replace", startLine: 1, endLine: 1, newText: "ONE" },
      ],
    }, cwd);

    assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\nfour\n");
    assert.match(result.content[0].text, /\[sample\.txt#[0-9a-f]{12}\]/);
    assert.doesNotMatch(result.content[0].text, /\n\d+:/);
    assert.ok(result.details.diff);
    assert.ok(result.details.patch);
    assert.equal(typeof result.details.firstChangedLine, "number");
    assert.notEqual(revision(result), revision(before));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("new revisions carry unchanged seen lines and remap them after insertions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-line-carry-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n"));
    const registered = tools();
    const read = registered.get("read");
    const edit = registered.get("edit");
    const before = await invoke(read, { path: "sample.txt" }, cwd);
    const first = await invoke(edit, {
      path: "sample.txt", revision: revision(before),
      edits: [
        { operation: "replace", startLine: 1, endLine: 1, newText: "LINE-1" },
        { operation: "replace", startLine: 15, endLine: 15, newText: "LINE-15" },
      ],
    }, cwd);
    assert.doesNotMatch(first.content[0].text, /\n\d+:/);
    const second = await invoke(edit, {
      path: "sample.txt", revision: revision(first),
      edits: [{ operation: "insert_before", line: 10, newText: "inserted" }],
    }, cwd);
    await invoke(edit, {
      path: "sample.txt", revision: revision(second),
      edits: [{ operation: "replace", startLine: 16, endLine: 16, newText: "LINE-15-AGAIN" }],
    }, cwd);
    assert.equal((await readFile(path, "utf8")).split("\n")[15], "LINE-15-AGAIN");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("overlapping operations fail before writing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-line-overlap-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, "one\ntwo\nthree\n");
    const registered = tools();
    const before = await invoke(registered.get("read"), { path: "sample.txt" }, cwd);
    await assert.rejects(
      invoke(registered.get("edit"), {
        path: "sample.txt",
        revision: revision(before),
        edits: [
          { operation: "replace", startLine: 1, endLine: 2, newText: "ONE\nTWO" },
          { operation: "replace", startLine: 2, endLine: 2, newText: "two" },
        ],
      }, cwd),
      /overlaps another operation/,
    );
    assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edits preserve a UTF-8 BOM and CRLF line endings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-line-crlf-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"));
    const registered = tools();
    const before = await invoke(registered.get("read"), { path: "sample.txt" }, cwd);
    await invoke(registered.get("edit"), {
      path: "sample.txt",
      revision: revision(before),
      edits: [{ operation: "replace", startLine: 2, endLine: 2, newText: "TWO" }],
    }, cwd);
    const bytes = await readFile(path);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString("utf8"), "\uFEFFone\r\nTWO\r\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
