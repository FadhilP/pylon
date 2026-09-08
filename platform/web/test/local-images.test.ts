import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  loadLocalImage,
  LocalImageLoadError,
  MAX_LOCAL_IMAGE_BYTES,
  localImageExtension,
} from "../src/server/runtime/local-images.ts";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pylon-local-image-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists local-image guidance once and restores it after each compaction", () => {
  const handlers = new Map<string, Function>();
  const branch: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [];
  if (typeof localImageExtension === "function") throw new Error("expected named inline extension");
  localImageExtension.factory({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    sendMessage: (message: Record<string, unknown>) => {
      messages.push(message);
      branch.push({ type: "custom_message", ...message });
    },
  } as any);
  const context = { sessionManager: { getBranch: () => branch } };

  handlers.get("session_start")!({}, context);
  handlers.get("session_start")!({}, context);
  assert.equal(messages.length, 1);

  const compact = { compactionEntry: { id: "compact-1" } };
  handlers.get("session_compact")!(compact, context);
  handlers.get("session_compact")!(compact, context);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1]!.details, { version: 1, compactionEntryId: "compact-1" });
});

test("loads a process-readable image by absolute file URL and detects its content type", async () => {
  await withTempDir(async directory => {
    const path = join(directory, "chart # 你好.not-png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path, bytes);

    const image = await loadLocalImage(pathToFileURL(path).href);

    assert.equal(image.name, "chart # 你好.not-png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.size, bytes.length);
    assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
  });
});

test("rejects unsupported, oversized, and non-file local image sources", async () => {
  await withTempDir(async directory => {
    const unsupported = join(directory, "image.png");
    const oversized = join(directory, "large.png");
    await writeFile(unsupported, "<svg></svg>");
    await writeFile(oversized, Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1));

    await assert.rejects(
      loadLocalImage(pathToFileURL(unsupported).href),
      error => error instanceof LocalImageLoadError && error.statusCode === 415,
    );
    await assert.rejects(
      loadLocalImage(pathToFileURL(oversized).href),
      error => error instanceof LocalImageLoadError && error.statusCode === 413,
    );
    await assert.rejects(
      loadLocalImage(pathToFileURL(directory).href),
      error => error instanceof LocalImageLoadError && error.statusCode === 415,
    );
    await assert.rejects(
      loadLocalImage("https://example.com/image.png"),
      error => error instanceof LocalImageLoadError && error.statusCode === 400,
    );
    await assert.rejects(
      loadLocalImage("file://server/share/image.png"),
      error => error instanceof LocalImageLoadError && error.statusCode === 400,
    );
    await assert.rejects(
      loadLocalImage(`${pathToFileURL(unsupported).href}#fragment`),
      error => error instanceof LocalImageLoadError && error.statusCode === 400,
    );
  });
});
