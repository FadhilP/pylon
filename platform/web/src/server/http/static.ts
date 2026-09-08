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
      handle: (request, response) =>
        new Promise<void>(done => {
          applySecurityHeaders(response, true);
          vite.middlewares(request, response, (error?: unknown) => {
            if (error && !response.writableEnded) {
              response.statusCode = 500;
              response.end("Development asset error");
            } else if (!response.writableEnded) {
              response.statusCode = 404;
              response.end("Not found");
            }
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
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.end();
        return;
      }
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      } catch {
        response.statusCode = 400;
        response.end();
        return;
      }
      const requested = resolve(dist, `.${pathname}`);
      const safe = requested === dist || requested.startsWith(`${dist}${sep}`);
      const requestedInfo = safe ? await fileInfo(requested) : undefined;
      if (!requestedInfo && extname(pathname)) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      const file = requestedInfo ? requested : index;
      const info = requestedInfo ?? await fileInfo(file);
      if (!info) {
        response.statusCode = 503;
        response.end("Web bundle not built");
        return;
      }
      const compressible = /\.(?:js|css|svg)$/.test(file);
      if (compressible) response.setHeader("vary", "Accept-Encoding");
      let representation: { file: string; size: number; encoding?: string } | undefined;
      for (const encoding of acceptedEncodings(request.headers["accept-encoding"] ?? "")) {
        if (encoding === "identity") { representation = { file, size: info.size }; break; }
        if (!compressible) continue;
        const variant = `${file}.${encoding === "gzip" ? "gz" : "br"}`;
        const compressed = await fileInfo(variant);
        // Never serve an old sidecar after an interrupted or partial build.
        if (compressed && compressed.mtimeMs >= info.mtimeMs) {
          representation = { file: variant, size: compressed.size, encoding };
          break;
        }
      }
      if (!representation) { response.statusCode = 406; response.end(); return; }
      response.statusCode = 200;
      response.setHeader("content-type", contentType(file));
      response.setHeader("cache-control", file === index ? "no-store" : "public, max-age=31536000, immutable");
      if (representation.encoding) response.setHeader("content-encoding", representation.encoding);
      response.setHeader("content-length", representation.size);
      response.end(request.method === "HEAD" ? undefined : await readFile(representation.file));
    },
    async close() {},
  };
}

async function fileInfo(path: string) {
  return stat(path).then(value => value.isFile() ? value : undefined, () => undefined);
}

function acceptedEncodings(header: string): string[] {
  const qualities = new Map<string, number>();
  for (const entry of header.toLowerCase().split(",")) {
    const [name, ...parameters] = entry.split(";").map(value => value.trim());
    const q = parameters.find(value => value.startsWith("q="))?.slice(2);
    qualities.set(name, q === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0);
  }
  const quality = (name: string) => qualities.get(name) ?? (name === "identity"
    ? qualities.get("*") === 0 ? 0 : 1
    : qualities.get("*") ?? 0);
  return ["br", "gzip", "identity"].filter(name => quality(name) > 0).sort((a, b) => quality(b) - quality(a));
}

function contentType(path: string): string {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".ico": "image/x-icon",
      } as Record<string, string>
    )[extname(path)] ?? "application/octet-stream"
  );
}
