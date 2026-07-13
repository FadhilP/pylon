import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeStatuses, footerRows, fitPair, plainText, shortWorkspace } from "../src/layout.ts";

test("layouts never exceed terminal width", () => {
  for (const width of [0, 1, 24, 40, 79, 80, 120]) {
    for (const density of ["compact", "comfortable"] as const) {
      const rows = footerRows(width, density, "long-workspace", "WORKING", "in 12.3k · out 2.1k · $1.234 · ctx 72%");
      assert.ok(rows.every(row => visibleWidth(row) <= width));
      assert.equal(rows.length, density === "comfortable" && width >= 80 ? 2 : 1);
    }
  }
});

test("pair preserves right status under pressure", () => {
  assert.equal(fitPair("workspace", "model", 8), "wo model");
  assert.equal(shortWorkspace("C:\\work\\repo"), "repo");
  assert.ok(visibleWidth(fitPair("工作区", "状态", 7)) <= 7);
  assert.ok(visibleWidth(fitPair("\x1b[31mwide status\x1b[0m", "ok", 8)) <= 8);
});

test("status ANSI cannot leak color into rest of footer", () => {
  assert.equal(plainText("\x1b[33mWORKING\x1b[39m"), "WORKING");
});

test("extension statuses compose instead of replacing each other", () => {
  assert.equal(
    composeStatuses(["Checkpoints: 2 · Session: Paired", "Verify: passed"], "READY"),
    "Checkpoints: 2 · Session: Paired · Verify: passed",
  );
  assert.equal(composeStatuses([], "READY"), "READY");
});

test("theme defines required visual groups", async () => {
  const theme = JSON.parse(await readFile(new URL("../themes/focus-dark.json", import.meta.url), "utf8"));
  for (const token of ["userMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolDiffAdded", "toolDiffRemoved", "thinkingMax"])
    assert.ok(token in theme.colors, token);
  assert.equal(theme.name, "focus-dark");
});
