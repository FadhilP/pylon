import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import {
  PublicNetworkProxy,
  isPublicAddress,
  resolvePublicHost,
  validatePublicWebUrl,
} from "../src/public-proxy.ts";

function proxyRequest(proxy: PublicNetworkProxy, url: string): Promise<number> {
  const target = new URL(proxy.serverUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: target.hostname, port: target.port, method: "GET", path: url },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function openProxyTunnel(
  proxy: PublicNetworkProxy,
  authority: string,
): Promise<{ socket: Socket; response: string }> {
  const target = new URL(proxy.serverUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    let response = "";
    socket.once("connect", () =>
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) resolve({ socket, response });
    });
    socket.once("error", reject);
  });
}

async function proxyConnect(
  proxy: PublicNetworkProxy,
  authority: string,
): Promise<string> {
  const { socket, response } = await openProxyTunnel(proxy, authority);
  socket.destroy();
  return response;
}

test("public address policy rejects local, reserved, transition, and metadata ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
  ])
    assert.equal(isPublicAddress(address, 4), false, address);
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(address, 6), false, address);
  assert.equal(isPublicAddress("8.8.8.8", 4), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
});

test("URL and DNS checks reject credentials, ports, ambiguous literals, and mixed answers", async () => {
  assert.throws(() => validatePublicWebUrl("file:///etc/passwd"), /HTTP/);
  assert.throws(
    () => validatePublicWebUrl("https://user:pass@example.com"),
    /credentials/,
  );
  assert.throws(
    () => validatePublicWebUrl("https://example.com:8443"),
    /ports/,
  );
  assert.equal(
    validatePublicWebUrl("http://2130706433/").hostname,
    "127.0.0.1",
  );
  await assert.rejects(
    resolvePublicHost("example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public/,
  );
  assert.deepEqual(
    await resolvePublicHost("example.test", async () => [
      { address: "93.184.216.34", family: 4 },
    ]),
    { address: "93.184.216.34", family: 4 },
  );
});

test("proxy enforces total request budget and idempotent cleanup", async () => {
  const proxy = await PublicNetworkProxy.start({
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    maxRequests: 1,
    maxBytes: 1024,
  });
  assert.equal(await proxyRequest(proxy, "http://example.test/"), 403);
  assert.equal(await proxyRequest(proxy, "http://example.test/"), 429);
  await proxy.close();
  await proxy.close();
});

test("capability proxy blocks private HTTP and HTTPS destinations before connection", async () => {
  const proxy = await PublicNetworkProxy.start(async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  try {
    assert.equal(await proxyRequest(proxy, "http://example.test/"), 403);
    assert.match(
      await proxyConnect(proxy, "example.test:443"),
      /^HTTP\/1\.1 403/,
    );
    assert.match(
      await proxyConnect(proxy, "example.test:22"),
      /^HTTP\/1\.1 403/,
    );
  } finally {
    await proxy.close();
  }
});

test("established tunnels do not consume establishment capacity and remain bounded", async () => {
  const accepted: Socket[] = [];
  const upstream = createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const proxy = await PublicNetworkProxy.start({
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    connector: () => connect(address.port, "127.0.0.1"),
    maxTunnels: 65,
  });
  const tunnels: Socket[] = [];
  try {
    for (let index = 0; index < 65; index++) {
      const tunnel = await openProxyTunnel(proxy, `example-${index}.test:443`);
      assert.match(tunnel.response, /^HTTP\/1\.1 200/);
      tunnels.push(tunnel.socket);
    }
    assert.equal(accepted.length, 65);
    assert.match(
      (await openProxyTunnel(proxy, "over-cap.test:443")).response,
      /^HTTP\/1\.1 429/,
    );

    const clientReleased = new Promise<void>((resolve) =>
      accepted[0].once("close", resolve),
    );
    tunnels[0].destroy();
    await clientReleased;
    const afterClientClose = await openProxyTunnel(
      proxy,
      "after-client-close.test:443",
    );
    assert.match(afterClientClose.response, /^HTTP\/1\.1 200/);
    tunnels.push(afterClientClose.socket);

    const upstreamReleased = new Promise<void>((resolve) =>
      tunnels[1].once("close", resolve),
    );
    accepted[1].destroy();
    await upstreamReleased;
    const afterUpstreamClose = await openProxyTunnel(
      proxy,
      "after-upstream-close.test:443",
    );
    assert.match(afterUpstreamClose.response, /^HTTP\/1\.1 200/);
    tunnels.push(afterUpstreamClose.socket);
  } finally {
    for (const socket of tunnels) socket.destroy();
    for (const socket of accepted) socket.destroy();
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("proxy capability endpoint is randomized and unavailable after cleanup", async () => {
  const proxy = await PublicNetworkProxy.start();
  const endpoint = new URL(proxy.serverUrl);
  assert.match(
    endpoint.hostname,
    /^127\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])(?:\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])){2}$/,
  );
  assert.notEqual(endpoint.hostname, "127.0.0.1");
  await proxy.close();
  await assert.rejects(proxyRequest(proxy, "http://example.com/"));
});
