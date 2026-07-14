import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { PublicNetworkProxy, isPublicAddress, resolvePublicHost, validatePublicWebUrl } from "../src/public-proxy.ts";

function proxyRequest(proxy: PublicNetworkProxy, url: string, authorized = true): Promise<number> {
  const target = new URL(proxy.serverUrl);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authorized) headers["proxy-authorization"] = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
    const req = request({ host: target.hostname, port: target.port, method: "GET", path: url, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

function proxyConnect(proxy: PublicNetworkProxy, authority: string): Promise<string> {
  const target = new URL(proxy.serverUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    let text = "";
    socket.once("connect", () => socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n\r\n`,
    ));
    socket.on("data", (chunk) => { text += chunk; if (text.includes("\r\n\r\n")) { socket.destroy(); resolve(text); } });
    socket.once("error", reject);
  });
}

test("public address policy rejects local, reserved, transition, and metadata ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
  ]) assert.equal(isPublicAddress(address, 4), false, address);
  for (const address of ["::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"])
    assert.equal(isPublicAddress(address, 6), false, address);
  assert.equal(isPublicAddress("8.8.8.8", 4), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
});

test("URL and DNS checks reject credentials, ports, ambiguous literals, and mixed answers", async () => {
  assert.throws(() => validatePublicWebUrl("file:///etc/passwd"), /HTTP/);
  assert.throws(() => validatePublicWebUrl("https://user:pass@example.com"), /credentials/);
  assert.throws(() => validatePublicWebUrl("https://example.com:8443"), /ports/);
  assert.equal(validatePublicWebUrl("http://2130706433/").hostname, "127.0.0.1");
  await assert.rejects(resolvePublicHost("example.test", async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]), /non-public/);
  assert.deepEqual(await resolvePublicHost("example.test", async () => [{ address: "93.184.216.34", family: 4 }]), { address: "93.184.216.34", family: 4 });
});

test("proxy enforces total request budget and idempotent cleanup", async () => {
  const proxy = await PublicNetworkProxy.start({ resolver: async () => [{ address: "127.0.0.1", family: 4 }], maxRequests: 1, maxBytes: 1024 });
  assert.equal(await proxyRequest(proxy, "http://example.test/"), 403);
  assert.equal(await proxyRequest(proxy, "http://example.test/"), 429);
  await proxy.close();
  await proxy.close();
});

test("authenticated proxy blocks private HTTP and HTTPS destinations before connection", async () => {
  const proxy = await PublicNetworkProxy.start(async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    assert.equal(await proxyRequest(proxy, "http://example.test/"), 403);
    assert.equal(await proxyRequest(proxy, "http://example.test/", false), 407);
    assert.match(await proxyConnect(proxy, "example.test:443"), /^HTTP\/1\.1 403/);
    assert.match(await proxyConnect(proxy, "example.test:22"), /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});
