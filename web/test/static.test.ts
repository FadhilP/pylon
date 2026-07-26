import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetHost } from "../src/server/http/static.ts";

test("production asset host serves SPA safely and rejects missing assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-static-"));
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Pylon</title>");
  await writeFile(join(dist, "assets", "app.js"), "export {};");
  const assets = await createAssetHost(root, false);
  const server = createServer((request, response) => void assets.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${origin}/workspace/overview`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Pylon/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const script = await fetch(`${origin}/assets/app.js`);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}/..%2Fsecret.txt`)).status, 404);
  } finally {
    await assets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
