import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ViteDevServer } from "vite";
import { applySecurityHeaders } from "./security.ts";

export interface AssetHost {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

export async function createAssetHost(webRoot: string, development: boolean): Promise<AssetHost> {
  if (development) {
    const { createServer } = await import("vite");
    const vite: ViteDevServer = await createServer({ root: webRoot, appType: "spa", server: { middlewareMode: true } });
    return {
      handle: (request, response) => new Promise<void>((done) => {
        applySecurityHeaders(response, true);
        vite.middlewares(request, response, (error?: unknown) => {
          if (error && !response.writableEnded) { response.statusCode = 500; response.end("Development asset error"); }
          else if (!response.writableEnded) { response.statusCode = 404; response.end("Not found"); }
          done();
        });
      }),
      close: () => vite.close(),
    };
  }

  const dist = resolve(webRoot, "dist");
  const index = resolve(dist, "index.html");
  return {
    async handle(request, response) {
      applySecurityHeaders(response);
      if (request.method !== "GET" && request.method !== "HEAD") { response.statusCode = 405; response.end(); return; }
      let pathname = "/";
      try { pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); } catch { response.statusCode = 400; response.end(); return; }
      const requested = resolve(dist, `.${pathname}`);
      const safe = requested === dist || requested.startsWith(`${dist}${sep}`);
      const requestedExists = safe && await isFile(requested);
      if (!requestedExists && extname(pathname)) { response.statusCode = 404; response.end("Not found"); return; }
      const file = requestedExists ? requested : index;
      if (!await isFile(file)) { response.statusCode = 503; response.end("Web bundle not built"); return; }
      const body = await readFile(file);
      response.statusCode = 200;
      response.setHeader("content-type", contentType(file));
      response.setHeader("cache-control", file === index ? "no-store" : "public, max-age=31536000, immutable");
      response.setHeader("content-length", body.byteLength);
      response.end(request.method === "HEAD" ? undefined : body);
    },
    async close() {},
  };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isFile(), () => false);
}

function contentType(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}
