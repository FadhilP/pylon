import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { BrowserSessionManager } from "../src/browser-session.ts";
import { PublicNetworkProxy } from "../src/public-proxy.ts";

const live = process.env.PI_HELIOS_LIVE_BROWSER === "1";
const exec = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number; cwd?: string }) => new Promise<any>((resolve) => {
  execFile(command, args, {
    cwd: options?.cwd,
    signal: options?.signal,
    timeout: options?.timeout,
    windowsHide: true,
    maxBuffer: 300 * 1024,
  }, (error, stdout, stderr) => resolve({
    code: typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0,
    stdout,
    stderr,
    killed: Boolean((error as any)?.killed),
  }));
});

function reference(snapshot: string | undefined, role: string): string {
  const match = snapshot?.split(/\r?\n/).find((line) => line.includes(`- ${role}`))?.match(/\[ref=(e\d+)\]/);
  assert.ok(match, `missing ${role} reference in snapshot`);
  return match[1];
}

test("live pinned CLI owned browser workflow", { skip: !live, timeout: 120_000 }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><title>Helios Live</title><label>Name <input></label><button onclick="document.title=\'Clicked\'">Submit</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const manager = new BrowserSessionManager(exec);
  try {
    await manager.start("live-contract", `http://127.0.0.1:${address.port}`);
    let snapshot = await manager.operate("live-contract", { kind: "snapshot", depth: 6 });
    await manager.operate("live-contract", { kind: "fill", target: reference(snapshot.snapshot, "textbox"), text: "Helios" });
    snapshot = await manager.operate("live-contract", { kind: "snapshot", depth: 6 });
    await manager.operate("live-contract", { kind: "click", target: reference(snapshot.snapshot, "button") });
    const screenshot = await manager.operate("live-contract", { kind: "screenshot", fullPage: true });
    assert.ok(screenshot.artifactPath);
    await rm(screenshot.artifactPath!, { force: true });
    await manager.operate("live-contract", { kind: "tab-new", url: "about:blank" });
    const tabs = await manager.operate("live-contract", { kind: "tab-list" });
    assert.equal(tabs.tabs?.length, 2);
    await manager.operate("live-contract", { kind: "tab-select", index: 0 });
    await manager.operate("live-contract", { kind: "tab-close", index: 1 });
    await manager.close("live-contract", "close");
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live Web Scout proxy prevents Chromium loopback bypass", { skip: !live, timeout: 120_000 }, async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("private"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const proxy = await PublicNetworkProxy.start();
  const manager = new BrowserSessionManager(exec);
  try {
    await manager.start("live-web-isolation", "about:blank", undefined, false, {
      proxy: { server: proxy.serverUrl, username: proxy.username, password: proxy.password },
    });
    await manager.operate("live-web-isolation", { kind: "navigate", url: `http://127.0.0.1:${address.port}/private` }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(requests, 0);
    await manager.close("live-web-isolation", "close");
  } finally {
    await manager.shutdown();
    await proxy.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live pinned CLI CDP attach/detach", { skip: !process.env.PI_HELIOS_LIVE_CDP, timeout: 90_000 }, async () => {
  const manager = new BrowserSessionManager(exec);
  try {
    await manager.attachCdp("live-cdp", process.env.PI_HELIOS_LIVE_CDP!);
    await manager.operate("live-cdp", { kind: "snapshot", depth: 3 });
    await manager.close("live-cdp", "detach");
  } finally { await manager.shutdown(); }
});
