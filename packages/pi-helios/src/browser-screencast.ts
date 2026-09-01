import { readFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_TARGET_RESPONSE_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const FRAME_INTERVAL_MS = 1000 / 30;
const RETRY_MS = 250;
const START_TIMEOUT_MS = 5_000;

export interface ScreencastPage {
  index: number;
  title: string;
  url: string;
}

export interface ScreencastFrame {
  mimeType: "image/jpeg";
  data: Buffer;
  sequence: number;
}

type Target = { id: string; title: string; type: string; url: string };
type PrivateEndpoint = { port: number; browserPath: string };

function endpoint(contents: string): PrivateEndpoint {
  const [portText, browserPath, ...rest] = contents.trim().split(/\r?\n/u);
  const port = Number(portText);
  if (
    rest.length ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath ?? "")
  ) {
    throw new Error("Helios browser returned an invalid private debugging endpoint");
  }
  return { port, browserPath };
}

async function localJson(port: number, path: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: "127.0.0.1", port, path, signal, timeout: 1_000 }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Helios private debugging endpoint rejected discovery"));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_TARGET_RESPONSE_BYTES) request.destroy(new Error("Discovery exceeded limit"));
      });
      response.once("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Helios private debugging endpoint returned invalid data"));
        }
      });
    });
    request.once("error", reject);
  });
}

async function targets(privateEndpoint: PrivateEndpoint, signal: AbortSignal): Promise<Target[]> {
  const version = await localJson(privateEndpoint.port, "/json/version", signal);
  const browserUrl =
    version && typeof version === "object" ? (version as Record<string, unknown>).webSocketDebuggerUrl : undefined;
  if (typeof browserUrl !== "string") throw new Error("Helios private debugging identity is unavailable");
  const parsedBrowserUrl = new URL(browserUrl);
  if (
    parsedBrowserUrl.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(parsedBrowserUrl.hostname) ||
    Number(parsedBrowserUrl.port) !== privateEndpoint.port ||
    parsedBrowserUrl.pathname !== privateEndpoint.browserPath ||
    parsedBrowserUrl.search ||
    parsedBrowserUrl.hash
  ) {
    throw new Error("Helios private debugging identity changed");
  }
  const value = await localJson(privateEndpoint.port, "/json/list", signal);
  if (!Array.isArray(value)) throw new Error("Helios private debugging endpoint returned invalid targets");
  return value
    .filter(
      (item): item is Target =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        /^[A-Fa-f0-9]+$/u.test(item.id) &&
        typeof item.title === "string" &&
        typeof item.type === "string" &&
        typeof item.url === "string",
    )
    .slice(0, 100);
}

export function selectScreencastTarget(items: Target[], page: ScreencastPage | undefined): Target | undefined {
  const pages = items.filter(item => item.type === "page");
  if (!page) return pages[0];
  // Chromium's /json/list is newest-first while Playwright tab indexes are creation-order.
  const indexed = pages[pages.length - 1 - page.index];
  if (indexed && indexed.url === page.url) return indexed;
  return (
    pages.find(item => item.url === page.url && item.title === page.title) ??
    pages.find(item => item.url === page.url) ??
    indexed ??
    pages[0]
  );
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser mirror stopped");
}

export class BrowserScreencast {
  private sequence = 0;
  private readonly profileDirectory: string;
  private readonly currentPage: () => ScreencastPage | undefined;

  constructor(profileDirectory: string, currentPage: () => ScreencastPage | undefined) {
    this.profileDirectory = profileDirectory;
    this.currentPage = currentPage;
  }

  async run(width: number, height: number, emit: (frame: ScreencastFrame) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw aborted(signal);
    const boundedWidth = Math.max(320, Math.min(1920, Math.round(width)));
    const boundedHeight = Math.max(240, Math.min(1080, Math.round(height)));
    const privateEndpoint = endpoint(await this.readEndpoint(signal));
    while (!signal.aborted) {
      try {
        const target = selectScreencastTarget(await targets(privateEndpoint, signal), this.currentPage());
        if (!target) throw new Error("Helios browser has no page to mirror");
        await this.streamTarget(privateEndpoint.port, target, boundedWidth, boundedHeight, emit, signal);
      } catch (error) {
        if (signal.aborted) throw aborted(signal);
        await delay(RETRY_MS, undefined, { signal }).catch(() => {});
        if (signal.aborted) throw aborted(signal);
        if (error instanceof TypeError) throw error;
      }
    }
  }

  private async readEndpoint(signal: AbortSignal): Promise<string> {
    const path = join(this.profileDirectory, "DevToolsActivePort");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (signal.aborted) throw aborted(signal);
      try {
        const value = await readFile(path, "utf8");
        if (Buffer.byteLength(value) > 256) throw new Error("Private debugging endpoint exceeded limit");
        return value;
      } catch (error) {
        if (attempt === 19) throw error;
        await delay(50, undefined, { signal });
      }
    }
    throw new Error("Helios private debugging endpoint is unavailable");
  }

  private async streamTarget(
    port: number,
    target: Target,
    width: number,
    height: number,
    emit: (frame: ScreencastFrame) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw aborted(signal);
    const selectedIndex = this.currentPage()?.index;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${target.id}`);
    await new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      let commandId = 2;
      let lastAckAt = 0;
      let ackTimer: NodeJS.Timeout | undefined;
      const startTimer = setTimeout(() => finish(new Error("Helios screencast startup timed out")), START_TIMEOUT_MS);
      startTimer.unref?.();
      const targetTimer = setInterval(() => {
        const page = this.currentPage();
        if (page && (page.index !== selectedIndex || page.url !== target.url)) finish();
      }, 100);
      targetTimer.unref?.();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        clearInterval(targetTimer);
        if (ackTimer) clearTimeout(ackTimer);
        signal.removeEventListener("abort", stop);
        try {
          socket.close();
        } catch {
          /* Already closed. */
        }
        error ? reject(error) : resolve();
      };
      const stop = () => finish(signal.aborted ? aborted(signal) : undefined);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) return stop();
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Page.startScreencast",
            params: { format: "jpeg", quality: 65, maxWidth: width, maxHeight: height, everyNthFrame: 1 },
          }),
        );
      });
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_FRAME_BYTES * 2)
          return finish(new Error("Helios screencast frame exceeded its protocol limit"));
        let message: any;
        try {
          message = JSON.parse(event.data);
        } catch {
          return finish(new Error("Helios screencast returned invalid data"));
        }
        if (message.id === 1) {
          if (message.error) return finish(new Error("Helios browser refused screencasting"));
          started = true;
          clearTimeout(startTimer);
          return;
        }
        if (message.method !== "Page.screencastFrame") return;
        const sessionId = message.params?.sessionId;
        if (!started || !Number.isSafeInteger(sessionId) || typeof message.params?.data !== "string")
          return finish(new Error("Helios screencast returned an invalid frame"));
        const data = Buffer.from(message.params.data, "base64");
        if (!data.length || data.length > MAX_FRAME_BYTES)
          return finish(new Error("Helios screencast frame exceeded its limit"));
        try {
          emit({ mimeType: "image/jpeg", data, sequence: ++this.sequence });
        } catch {
          return finish(new Error("Helios screencast consumer failed"));
        }
        const wait = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - lastAckAt));
        ackTimer = setTimeout(() => {
          ackTimer = undefined;
          if (settled) return;
          try {
            socket.send(JSON.stringify({ id: commandId++, method: "Page.screencastFrameAck", params: { sessionId } }));
            lastAckAt = performance.now();
          } catch {
            finish();
          }
        }, wait);
        ackTimer.unref?.();
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () => finish(new Error("Helios screencast connection failed")));
    });
  }
}
