import assert from "node:assert/strict";
import test from "node:test";
import { parseFileReference } from "../src/shared/file-reference.ts";

test("parses workspace file references and source locations", () => {
  assert.deepEqual(parseFileReference("platform/web/src/client/App.tsx"), { path: "platform/web/src/client/App.tsx" });
  assert.deepEqual(parseFileReference("./src/main.ts:42"), { path: "src/main.ts", line: 42 });
  assert.deepEqual(parseFileReference("src/main.ts:42:7"), { path: "src/main.ts", line: 42, column: 7 });
  assert.deepEqual(parseFileReference("src/main.ts#L42C7"), { path: "src/main.ts", line: 42, column: 7 });
  assert.deepEqual(parseFileReference("src%2Fwith%20space.ts%23L3"), { path: "src/with space.ts", line: 3 });
});

test("leaves external and unsafe links to normal browser handling", () => {
  for (const href of [
    "https://example.com/file.ts",
    "mailto:user@example.com",
    "tel:123",
    "ssh:server",
    "vscode:workspace",
    "urn:foo.bar:22",
    "#section",
    "/absolute/file.ts",
    "C:/absolute/file.ts:2",
    "../outside.ts:2",
    "src/../outside.ts:2",
    "src/file.ts?plain=1",
    "src/file.ts#section",
    "src/file.ts:0",
  ]) assert.equal(parseFileReference(href), undefined, href);
});
