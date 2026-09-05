import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;

const LOCAL_IMAGE_GUIDANCE =
  "Pylon renders readable local PNG, JPEG, WebP, and GIF files via ![alt](file:///absolute/path). Use this when requested or clearly useful; never expose sensitive or unrelated files or invent paths.";
export const LOCAL_IMAGE_GUIDANCE_TYPE = "pylon-local-image-guidance";

function hasGuidance(branch: unknown[], compactionEntryId?: string): boolean {
  return branch.some(value => {
    if (!value || typeof value !== "object") return false;
    const entry = value as {
      type?: unknown;
      customType?: unknown;
      details?: { compactionEntryId?: unknown };
      message?: { customType?: unknown; details?: { compactionEntryId?: unknown } };
    };
    const matchesType =
      entry.type === "custom_message" &&
      (entry.customType === LOCAL_IMAGE_GUIDANCE_TYPE || entry.message?.customType === LOCAL_IMAGE_GUIDANCE_TYPE);
    if (!matchesType) return false;
    return (
      compactionEntryId === undefined ||
      entry.details?.compactionEntryId === compactionEntryId ||
      entry.message?.details?.compactionEntryId === compactionEntryId
    );
  });
}

export const localImageExtension: InlineExtension = {
  name: "pylon-local-images",
  hidden: true,
  factory: pi => {
    pi.on("session_start", (_event, context) => {
      if (process.env.PI_SPAWN_CHILD === "session" || hasGuidance(context.sessionManager.getBranch())) return;
      pi.sendMessage({ customType: LOCAL_IMAGE_GUIDANCE_TYPE, content: LOCAL_IMAGE_GUIDANCE, display: false });
    });
    pi.on("session_compact", (event, context) => {
      if (process.env.PI_SPAWN_CHILD === "session") return;
      const compactionEntryId = event.compactionEntry?.id;
      if (!compactionEntryId || hasGuidance(context.sessionManager.getBranch(), compactionEntryId)) return;
      pi.sendMessage({
        customType: LOCAL_IMAGE_GUIDANCE_TYPE,
        content: LOCAL_IMAGE_GUIDANCE,
        display: false,
        details: { version: 1, compactionEntryId },
      });
    });
  },
};

export interface LoadedLocalImage {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  data: string;
}

export class LocalImageLoadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "LocalImageLoadError";
  }
}

export async function loadLocalImage(source: string): Promise<LoadedLocalImage> {
  if (!source || source.length > 8_192) throw new LocalImageLoadError("invalid local image URL", 400);

  let path: string;
  try {
    const url = new URL(source);
    if (url.protocol !== "file:" || url.hostname || url.search || url.hash)
      throw new Error("not a plain local file URL");
    path = fileURLToPath(url);
  } catch {
    throw new LocalImageLoadError("invalid local image URL", 400);
  }
  if (!isAbsolute(path) || path.includes("\0") || path.startsWith("\\\\") || path.startsWith("//"))
    throw new LocalImageLoadError("local image path must be an absolute local path", 400);

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const file = await handle.stat();
    if (!file.isFile()) throw new LocalImageLoadError("local image is not a file", 415);
    if (file.size <= 0 || file.size > MAX_LOCAL_IMAGE_BYTES)
      throw new LocalImageLoadError("local image exceeds the 5 MB limit", 413);
    const bytes = await readBounded(handle);
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_LOCAL_IMAGE_BYTES)
      throw new LocalImageLoadError("local image exceeds the 5 MB limit", 413);
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new LocalImageLoadError("local image format is unsupported", 415);
    return { name: basename(path), mimeType, size: bytes.byteLength, data: bytes.toString("base64") };
  } catch (error) {
    if (error instanceof LocalImageLoadError) throw error;
    throw new LocalImageLoadError("local image is unavailable", 404);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_LOCAL_IMAGE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function matches(bytes: Buffer, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function imageMimeType(bytes: Buffer): LoadedLocalImage["mimeType"] | undefined {
  if (
    bytes.length >= 45 &&
    matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    matches(bytes, 12, [0x49, 0x48, 0x44, 0x52]) &&
    matches(bytes, bytes.length - 8, [0x49, 0x45, 0x4e, 0x44])
  )
    return "image/png";
  if (bytes.length >= 4 && matches(bytes, 0, [0xff, 0xd8, 0xff]) && matches(bytes, bytes.length - 2, [0xff, 0xd9]))
    return "image/jpeg";
  if (
    bytes.length >= 14 &&
    (matches(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      matches(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) &&
    bytes.at(-1) === 0x3b
  )
    return "image/gif";
  if (
    bytes.length >= 16 &&
    matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    matches(bytes, 8, [0x57, 0x45, 0x42, 0x50]) &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.subarray(12, 16).toString("latin1")) &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  )
    return "image/webp";
}
