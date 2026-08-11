import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("copyText reports clipboard success and rejection", async () => {
  const { copyText } = await import(new URL("../src/client/clipboard.ts", import.meta.url).href);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes: string[] = [];
  let reject = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (value: string) => {
      if (reject) throw new Error("denied");
      writes.push(value);
    } } },
  });

  try {
    assert.equal(await copyText("first"), true);
    assert.deepEqual(writes, ["first"]);
    reject = true;
    assert.equal(await copyText("second"), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("copy feedback invalidates stale results and refreshes repeated announcements", () => {
  const filesPanel = readFileSync(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8");
  const copyResult = filesPanel.indexOf("const state = await copyText(path)");
  const staleGuard = filesPanel.indexOf("if (revision !== copyRevision.current) return;", copyResult);
  const feedbackUpdate = filesPanel.indexOf("setCopyFeedback({ path, state });", staleGuard);
  assert.ok(copyResult >= 0 && staleGuard > copyResult && feedbackUpdate > staleGuard);
  assert.match(filesPanel, /copyRevision\.current\+\+;\s+setCopyFeedback\(undefined\);[\s\S]*?\}, \[selectedPath\]\);/);

  const sidebar = readFileSync(new URL("../src/client/session-sidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /setAnnouncement\(""\);\s+void copyText\(value\)/);
});
