import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AndroidRunner, type AndroidSdkController } from "pylon-android/android-runner";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import { PylonAndroidHost } from "../src/server/android/pylon-android-host.ts";
import { startPylonServer } from "../src/server/index.ts";
import { initialOperational } from "../src/server/runtime/operational-projections.ts";

function driver(dispose: () => void, start = async () => undefined) {
  return {
    start,
    dispose: async () => dispose(),
    snapshot: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: "session-1",
      sessionGeneration: 1,
      ready: true,
      cwdLabel: "workspace",
      activeTools: [],
      availableTools: [],
      optionalCapabilities: {},
      diagnostics: [],
      conversation: {
        messages: [],
        tools: [],
        delegatedRuns: [],
        streaming: false,
        queue: { steering: 0, followUp: 0 },
        retry: { active: false },
        compaction: { active: false },
      },
      sessionControls: {
        model: { provider: "mock", id: "test", name: "Test" },
        models: [{ provider: "mock", id: "test", name: "Test" }],
        thinkingLevel: "medium",
        thinkingLevels: ["low", "medium", "high"],
      },
      runtimePolicy: {
        revision: 1,
        global: {
          timelineEnabled: true,
          guardEnabled: true,
          workspace: "local",
          guardTimeoutSeconds: 60,
          clarifyTimeoutSeconds: 60,
        },
        project: {
          verify: { mode: "auto" },
          timelineEnabled: true,
          guardEnabled: true,
          workspace: "local",
          guardTimeoutSeconds: 60,
          clarifyTimeoutSeconds: 60,
        },
        session: {},
        effective: {
          verify: { mode: "auto" },
          timelineEnabled: true,
          guardEnabled: true,
          workspace: "local",
          guardTimeoutSeconds: 60,
          clarifyTimeoutSeconds: 60,
        },
        availableVerifyChecks: [],
      },
      metrics: {
        model: "test",
        provider: "mock",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextTokens: 0,
        contextLimit: 1,
        contextPercent: 0,
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
      },
      operational: initialOperational([], []),
      extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
    }),
    subscribe: () => () => undefined,
  } as any;
}

function androidHost(stopped: () => void) {
  const sdk: AndroidSdkController = {
    async listAvds() {
      return ["Pixel_External", "Pixel_Owned"];
    },
    async devices() {
      return [{ serial: "emulator-5554", state: "device" }];
    },
    async avdName() {
      return "Pixel_External";
    },
    async start(avd) {
      return {
        serial: "emulator-5556",
        avd,
        async stop() {
          stopped();
        },
        async cleanupUncertainStart() {
          stopped();
        },
      };
    },
  };
  let id = 0;
  return new PylonAndroidHost(new AndroidRunner({ createSdk: async () => sdk, idFactory: () => `device-${++id}` }));
}

async function json(response: Response): Promise<any> {
  return response.json();
}

test("Android transport enforces browser security, revisions, idempotency, and shutdown ownership", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pylon-android-transport-"));
  let driverDisposals = 0;
  let stops = 0;
  const host = androidHost(() => stops++);
  const running = await startPylonServer({
    port: 0,
    development: false,
    agentDir: temp,
    driver: driver(() => driverDisposals++),
    androidHost: host,
  });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  const tab = "android-tab";
  const mainAbort = new AbortController();
  const androidAbort = new AbortController();
  const secondMainAbort = new AbortController();
  const secondAndroidAbort = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/v1/android`)).status, 403);
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const bootstrapBody = await json(bootstrap);
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrapBody));
    const csrf = String(bootstrapBody.csrfToken);
    const readHeaders = { cookie, "x-pylon-tab-id": tab };
    const headers = { ...readHeaders, "content-type": "application/json", "x-pylon-csrf": csrf };

    const snapshotResponse = await fetch(`${origin}/api/v1/android`, { headers: readHeaders });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.headers.get("cache-control"), "no-store");
    const snapshot = await json(snapshotResponse);
    const send = (value: unknown, requestHeaders = headers) =>
      fetch(`${origin}/api/v1/android/command`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(value),
      });
    const start = {
      type: "startEmulator",
      commandId: "00000000-0000-4000-8000-000000000011",
      expectedServiceRevision: snapshot.serviceRevision,
      avd: "Pixel_Owned",
    };
    const withoutPresence = await send(start);
    assert.equal(withoutPresence.status, 409, JSON.stringify(await json(withoutPresence)));

    const mainEvents = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, {
      headers: { cookie },
      signal: mainAbort.signal,
    });
    const withoutAndroidPresence = await send({ ...start, commandId: "00000000-0000-4000-8000-000000000016" });
    assert.equal(withoutAndroidPresence.status, 409);
    assert.match(String((await json(withoutAndroidPresence)).error), /Android event connection/);
    await mainEvents.body!.getReader().read();
    assert.equal(
      (
        await fetch(
          `${origin}/api/v1/android/events?tabId=${tab}&csrf=bad&cursor=${encodeURIComponent(host.cursor(snapshot.sequence))}`,
          { headers: { cookie } },
        )
      ).status,
      403,
    );
    const androidEvents = await fetch(
      `${origin}/api/v1/android/events?tabId=${tab}&csrf=${encodeURIComponent(csrf)}&cursor=${encodeURIComponent(host.cursor(snapshot.sequence))}`,
      { headers: { cookie }, signal: androidAbort.signal },
    );
    await androidEvents.body!.getReader().read();

    assert.equal(
      (
        await send({
          type: "saveRunConfiguration",
          commandId: "00000000-0000-4000-8000-000000000013",
          expectedServiceRevision: snapshot.serviceRevision,
          expectedGeneration: 1,
          expectedConfigRevision: 0,
          candidateId: "root",
          modulePath: ":app",
          variant: "debug",
          workspaceRoot: "C:\\untrusted",
        })
      ).status,
      400,
    );
    assert.equal((await send({ ...start, extra: true })).status, 400);
    assert.equal((await send({ ...start, expectedServiceRevision: 0 })).status, 409);
    assert.equal((await send(start, { ...headers, "x-pylon-csrf": "bad" })).status, 403);
    const accepted = await send(start);
    assert.equal(accepted.status, 200);
    assert.equal((await send(start)).status, 200);
    assert.equal((await send({ ...start, avd: "Pixel_External" })).status, 409);

    const current = await json(await fetch(`${origin}/api/v1/android`, { headers: readHeaders }));
    const external = current.runner.devices.find((item: any) => item.ownership === "external");
    assert.equal(
      (
        await send({
          type: "stopEmulator",
          commandId: "00000000-0000-4000-8000-000000000012",
          expectedServiceRevision: current.serviceRevision,
          deviceId: external.deviceId,
          deviceRevision: external.revision,
        })
      ).status,
      409,
    );

    const secondTab = "android-tab-2";
    const secondBootstrap = await fetch(`${origin}/api/v1/bootstrap`, {
      headers: { cookie, "x-pylon-tab-id": secondTab },
    });
    const secondBody = await json(secondBootstrap);
    const secondHeaders = {
      cookie,
      "x-pylon-tab-id": secondTab,
      "content-type": "application/json",
      "x-pylon-csrf": String(secondBody.csrfToken),
    };
    const secondMainEvents = await fetch(`${origin}/api/v1/events?tabId=${secondTab}&cursor=1:0`, {
      headers: { cookie },
      signal: secondMainAbort.signal,
    });
    await secondMainEvents.body!.getReader().read();
    const secondSnapshot = await json(
      await fetch(`${origin}/api/v1/android`, { headers: { cookie, "x-pylon-tab-id": secondTab } }),
    );
    const secondAndroidEvents = await fetch(
      `${origin}/api/v1/android/events?tabId=${secondTab}&csrf=${encodeURIComponent(String(secondBody.csrfToken))}&cursor=${encodeURIComponent(host.cursor(secondSnapshot.sequence))}`,
      { headers: { cookie }, signal: secondAndroidAbort.signal },
    );
    await secondAndroidEvents.body!.getReader().read();
    const owned = secondSnapshot.runner.devices.find((item: any) => item.ownership === "runner");
    const secondSend = (value: unknown) =>
      fetch(`${origin}/api/v1/android/command`, {
        method: "POST",
        headers: secondHeaders,
        body: JSON.stringify(value),
      });
    const stopOwned = {
      type: "stopEmulator",
      commandId: "00000000-0000-4000-8000-000000000014",
      expectedServiceRevision: snapshot.serviceRevision,
      deviceId: owned.deviceId,
      deviceRevision: owned.revision,
    };
    assert.equal((await secondSend(stopOwned)).status, 409);
    assert.equal(
      (
        await secondSend({
          ...stopOwned,
          commandId: "00000000-0000-4000-8000-000000000015",
          expectedServiceRevision: secondSnapshot.serviceRevision,
        })
      ).status,
      200,
    );
  } finally {
    mainAbort.abort();
    androidAbort.abort();
    secondMainAbort.abort();
    secondAndroidAbort.abort();
    await running.close();
    await rm(temp, { recursive: true, force: true });
  }
  assert.equal(stops, 1);
  assert.equal(driverDisposals, 1);
});

test("server startup failure disposes the already-created Android host", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pylon-android-start-failure-"));
  let disposed = 0;
  const runner = {
    snapshot: () => ({ lifecycle: "active", revision: 0, discovery: "idle", avds: [], devices: [] }),
    subscribe: () => () => undefined,
    refresh: async () => ({ lifecycle: "active", revision: 0, discovery: "ready", avds: [], devices: [] }),
    startEmulator: async () => {
      throw new Error("unused");
    },
    cancelOperation: () => undefined,
    stopEmulator: async () => undefined,
    dispose: async () => {
      disposed++;
    },
  };
  const host = new PylonAndroidHost(runner as any);
  try {
    await assert.rejects(
      startPylonServer({
        port: 0,
        development: false,
        agentDir: temp,
        driver: driver(
          () => undefined,
          async () => {
            throw new Error("driver start failed");
          },
        ),
        androidHost: host,
      }),
      /driver start failed/,
    );
    assert.equal(disposed, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Android cleanup failure does not skip normal Pylon server shutdown", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pylon-android-close-failure-"));
  let driverDisposals = 0;
  const runner = {
    snapshot: () => ({ lifecycle: "active", revision: 0, discovery: "idle", avds: [], devices: [] }),
    subscribe: () => () => undefined,
    refresh: async () => ({ lifecycle: "active", revision: 0, discovery: "ready", avds: [], devices: [] }),
    startEmulator: async () => {
      throw new Error("unused");
    },
    cancelOperation: () => undefined,
    stopEmulator: async () => undefined,
    dispose: async () => {
      throw new Error("Android cleanup failed");
    },
  };
  const running = await startPylonServer({
    port: 0,
    development: false,
    agentDir: temp,
    driver: driver(() => driverDisposals++),
    androidHost: new PylonAndroidHost(runner as any),
  });
  try {
    const closing = running.close();
    await assert.rejects(closing, /Pylon server cleanup failed/);
    await assert.rejects(running.close(), /Pylon server cleanup failed/);
    assert.equal(running.server.listening, false);
    assert.equal(driverDisposals, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
