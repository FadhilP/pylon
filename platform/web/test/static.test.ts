import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetHost } from "../src/server/http/static.ts";
import { applySecurityHeaders } from "../src/server/http/security.ts";
import { build, type InlineConfig } from "vite";
import { precompressAssets } from "../vite.config.ts";

test("production asset host serves SPA safely and rejects missing assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-static-"));
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Pylon</title>");
  await writeFile(join(dist, "assets", "app.js"), "export {};");
  const assets = await createAssetHost(root, false);
  const server = createServer((request, response) => void assets.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${origin}/workspace/overview`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Pylon/);
    const contentSecurityPolicy = page.headers.get("content-security-policy") ?? "";
    assert.match(contentSecurityPolicy, /default-src 'self'/);
    assert.match(contentSecurityPolicy, /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);
    assert.match(contentSecurityPolicy, /img-src 'self' data: blob:/);
    const script = await fetch(`${origin}/assets/app.js`);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}/..%2Fsecret.txt`)).status, 404);
  } finally {
    await assets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("compressed assets negotiate encodings, reject stale variants, and preserve HEAD/security behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-compressed-static-"));
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  const source = 'console.log("hello");'.repeat(100);
  const file = join(dist, "assets", "app.js");
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Pylon</title>");
  await writeFile(file, source);
  const brotli = brotliCompressSync(source);
  await writeFile(`${file}.br`, brotli);
  await writeFile(`${file}.gz`, gzipSync(source));
  const assets = await createAssetHost(root, false);
  const server = createServer((request, response) => void assets.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (encoding: string, method = "GET") => fetch(`${origin}/assets/app.js`, { method, headers: { "accept-encoding": encoding } });
  try {
    const br = await get("gzip, br");
    assert.equal(br.headers.get("content-encoding"), "br");
    assert.equal(await br.text(), source);
    assert.match(br.headers.get("vary") ?? "", /Accept-Encoding/i);
    assert.equal(br.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(br.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(br.headers.get("x-content-type-options"), "nosniff");
    const gz = await get("br;q=0.5, gzip;q=1, identity;q=0");
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    assert.equal(await gz.text(), source);
    const identity = await get("br;q=0, gzip;q=0");
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(await identity.text(), source);
    assert.equal((await get("*;q=0")).status, 406);
    const head = await get("br", "HEAD");
    assert.equal(head.headers.get("content-encoding"), "br");
    assert.equal(Number(head.headers.get("content-length")), brotli.length);
    assert.equal(await head.text(), "");
    await utimes(`${file}.br`, new Date(0), new Date(0));
    const fallback = await get("br, gzip");
    assert.equal(fallback.headers.get("content-encoding"), "gzip");
    assert.equal(await fallback.text(), source);
    await rm(`${file}.gz`);
    const plain = await get("br, gzip");
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(await plain.text(), source);
    const page = await fetch(`${origin}/workspace`, { headers: { "accept-encoding": "br, gzip" } });
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("content-encoding"), null);
  } finally {
    await assets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("build compression matches finalized JS/CSS, removes obsolete variants, and propagates write failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-build-compression-"));
  const assets = join(root, "dist", "assets");
  const options: InlineConfig = {
    root, configFile: false, logLevel: "silent", plugins: [precompressAssets()],
    build: {
      emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: "assets/main.js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
    },
  };
  const css = `.app { --label: "${"initial ".repeat(300)}"; }`;
  try {
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
    await writeFile(join(root, "main.js"), `import "./main.css"; globalThis.payload = "${"initial ".repeat(300)}"; globalThis.openPanel = () => import("./panel.js");`);
    await writeFile(join(root, "main.css"), css);
    await writeFile(join(root, "panel.js"), `import "./panel.css"; export const payload = "${"panel ".repeat(300)}";`);
    await writeFile(join(root, "panel.css"), `.panel { --label: "${"panel ".repeat(300)}"; }`);
    const compareVariants = async () => {
      const names = await readdir(assets);
      assert.ok(names.some(name => name.endsWith(".js.br")));
      assert.ok(names.some(name => name.endsWith(".css.br")));
      assert.ok(names.some(name => name.endsWith(".js.gz")));
      assert.ok(names.some(name => name.endsWith(".css.gz")));
      for (const name of names.filter(name => /\.(?:br|gz)$/.test(name))) {
        const original = await readFile(join(assets, name.replace(/\.(?:br|gz)$/, "")));
        const encoded = await readFile(join(assets, name));
        assert.deepEqual(name.endsWith(".br") ? brotliDecompressSync(encoded) : gunzipSync(encoded), original, name);
        assert.ok(encoded.byteLength < original.byteLength);
      }
    };
    await build(options);
    await compareVariants();
    assert.ok((await readFile(join(assets, "index.css.br"))).byteLength);
    // Fixed filenames with output cleaning disabled exercise a watch-style rebuild.
    await writeFile(join(root, "main.css"), ".app { color: red; }");
    await writeFile(join(root, "panel.js"), `import "./panel.css"; export const payload = "${"changed ".repeat(300)}";`);
    await build(options);
    await compareVariants();
    await assert.rejects(readFile(join(assets, "index.css.br")), { code: "ENOENT" });
    await assert.rejects(readFile(join(assets, "index.css.gz")), { code: "ENOENT" });
    await writeFile(join(root, "main.css"), css);
    await mkdir(join(assets, "index.css.br"));
    await assert.rejects(build(options));
    assert.ok(!(await readdir(assets)).some(name => name.includes(".tmp-")));
    await build({ ...options, build: { ...options.build, outDir: "ssr", ssr: join(root, "main.js") } });
    const serverFiles = await readdir(join(root, "ssr"), { recursive: true });
    const serverScripts = await Promise.all(serverFiles.filter(name => name.endsWith(".js")).map(name => readFile(join(root, "ssr", name))));
    assert.ok(serverScripts.some(body => body.byteLength > 1_024));
    assert.ok(!serverFiles.some(name => /\.(?:br|gz)$/.test(name)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("development CSP permits Vite bootstrap scripts without weakening production", () => {
  const headers = new Map<string, string>();
  applySecurityHeaders({ setHeader: (name: string, value: string) => headers.set(name, value) } as any, true);
  const policy = headers.get("content-security-policy") ?? "";
  assert.match(policy, /script-src 'self' 'unsafe-inline'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
});
