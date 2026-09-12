import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { AndroidCommand, AndroidServiceSnapshot } from "../src/shared/protocol/android.ts";

class FakeSource {
  readonly listeners = new Map<string, EventListener>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closed = false;
  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: unknown): void {
    this.listeners.get(type)?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
  }
}

function snapshot(sequence: number, revision = sequence): AndroidServiceSnapshot {
  return {
    protocolVersion: 4,
    serviceEpoch: "epoch-a",
    sequence,
    serviceRevision: revision,
    runner: { lifecycle: "active", revision, discovery: "ready", avds: ["Pixel_Test"], devices: [] },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("AndroidStore applies ordered host-global events and snapshot-recovers gaps", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
  });
  let store: { dispose(): void } | undefined;
  try {
    const { AndroidStore, androidProjectForGeneration } = await vite.ssrLoadModule(
      "/src/client/android/android-store.ts",
    );
    const sources: FakeSource[] = [];
    const snapshots = [snapshot(0), snapshot(3)];
    const commands: AndroidCommand[] = [];
    let finishRefresh: (() => void) | undefined;
    let holdSnapshot = false;
    let releaseSnapshot: (() => void) | undefined;
    let bootstrapCalls = 0;
    const api = {
      bootstrap: async () => {
        bootstrapCalls++;
        return {};
      },
      androidSnapshot: async () => {
        if (holdSnapshot) {
          await new Promise<void>(resolve => {
            releaseSnapshot = resolve;
          });
          holdSnapshot = false;
        }
        return snapshots.shift()!;
      },
      androidEvents: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      androidCommand: async (command: AndroidCommand) => {
        commands.push(command);
        if (command.type === "refresh") {
          await new Promise<void>(resolve => {
            finishRefresh = resolve;
          });
          return { commandId: command.commandId, snapshot: snapshot(6, 6) };
        }
        if (command.type === "refreshProject") {
          return {
            commandId: command.commandId,
            snapshot: {
              ...snapshot(7, 7),
              project: {
                projectId: "project-1",
                sessionId: "session-1",
                sessionGeneration: command.expectedGeneration,
                workspaceKind: "project-folder" as const,
                workspaceLabel: "Project",
                discovery: "ready" as const,
                modules: [{ modulePath: ":app", variants: ["debug"] }],
                trust: { status: "untrusted" as const, revision: 0 },
              },
            },
          };
        }
        const revision = command.type === "cancelOperation" ? 5 : 4;
        return { commandId: command.commandId, snapshot: snapshot(revision, revision) };
      },
    };
    const androidStore = new AndroidStore(api);
    store = androidStore;
    androidStore.start();
    await until(() => androidStore.getSnapshot().status === "ready");
    assert.equal(androidStore.getSnapshot().service?.sequence, 0);
    sources[0].onopen?.({} as Event);
    assert.equal(androidStore.getSnapshot().connected, true);

    sources[0].emit("android.snapshot", {
      protocolVersion: 4,
      serviceEpoch: "epoch-a",
      sequence: 1,
      serviceRevision: 1,
      type: "android.snapshot",
      payload: {
        runner: {
          lifecycle: "active",
          revision: 1,
          discovery: "ready",
          avds: ["Pixel_Test"],
          devices: [
            {
              deviceId: "external-1",
              serial: "emulator-5554",
              avd: "Pixel_Test",
              ownership: "external",
              state: "ready",
              revision: 1,
            },
          ],
        },
      },
    });
    holdSnapshot = true;
    assert.equal(androidStore.getSnapshot().service?.runner.devices[0].ownership, "external");

    sources[0].emit("android.snapshot", {
      protocolVersion: 4,
      serviceEpoch: "epoch-a",
      sequence: 3,
      serviceRevision: 3,
      type: "android.snapshot",
      payload: { runner: snapshot(3).runner },
    });
    assert.equal(androidStore.getSnapshot().connected, false);
    assert.equal(sources[0].closed, true);
    releaseSnapshot?.();
    await until(() => sources.length === 2);
    assert.equal(sources[0].closed, true);
    assert.equal(androidStore.getSnapshot().service?.sequence, 3);
    sources[1].onopen?.({} as Event);
    assert.equal(androidStore.getSnapshot().connected, true);

    await androidStore.startEmulator("Pixel_Test");
    assert.equal(commands[0].expectedServiceRevision, 3);
    assert.equal(androidStore.getSnapshot().service?.sequence, 4);

    const refreshing = androidStore.refresh();
    await until(() => androidStore.getSnapshot().busy === "refresh");
    const cancelling = androidStore.cancelOperation("device-slow", 1);
    assert.equal(androidStore.getSnapshot().busy, "cancelOperation");
    await cancelling;
    assert.equal(androidStore.getSnapshot().busy, "refresh");
    finishRefresh?.();
    await refreshing;
    assert.equal(androidStore.getSnapshot().busy, undefined);
    assert.equal(androidStore.getSnapshot().service?.sequence, 6);

    await androidStore.refreshProject(9);
    assert.equal(commands.at(-1)?.type, "refreshProject");
    assert.equal(commands.at(-1)?.expectedServiceRevision, 6);
    assert.equal(androidStore.getSnapshot().service?.project?.sessionGeneration, 9);
    assert.equal(androidStore.getSnapshot().service?.project?.modules[0]?.modulePath, ":app");
    assert.equal(androidProjectForGeneration(androidStore.getSnapshot().service, 10), undefined);
    assert.equal(androidProjectForGeneration(androidStore.getSnapshot().service, 9)?.projectId, "project-1");

    const escapedOutput = '"\\\n'.repeat(50_000);
    assert.ok(JSON.stringify(escapedOutput).length > 256 * 1024);
    sources[1].emit("android.snapshot", {
      protocolVersion: 4,
      serviceEpoch: "epoch-a",
      sequence: 8,
      serviceRevision: 8,
      type: "android.snapshot",
      payload: {
        runner: snapshot(8).runner,
        build: {
          operationId: "00000000-0000-4000-8000-000000000099",
          revision: 2,
          projectId: "project-1",
          sessionId: "session-1",
          sessionGeneration: 9,
          workspaceLabel: "Project",
          modulePath: ":app",
          variant: "debug",
          state: "running",
          startedAt: new Date(0).toISOString(),
          output: escapedOutput,
          outputTruncated: false,
        },
        run: {
          runId: "00000000-0000-4000-8000-000000000098",
          operationId: "00000000-0000-4000-8000-000000000099",
          revision: 3,
          projectId: "project-1",
          sessionId: "session-1",
          sessionGeneration: 9,
          workspaceLabel: "Project",
          modulePath: ":app",
          variant: "debug",
          deviceId: "external-1",
          deviceRevision: 1,
          serial: "emulator-5554",
          avd: "Pixel_Test",
          ownership: "external",
          phase: "running",
          startedAt: new Date(0).toISOString(),
          installed: true,
          logs: { revision: 1, state: "running", output: "package log", outputTruncated: false },
        },
      },
    });
    assert.equal(androidStore.getSnapshot().service?.build?.output.length, escapedOutput.length);
    assert.equal(androidStore.getSnapshot().service?.run?.logs.output, "package log");
    snapshots.push(snapshot(9));
    sources[1].onopen?.({} as Event);
    await until(() => sources.length === 3);
    assert.equal(bootstrapCalls, 2);
    assert.equal(sources[1].closed, true);
    assert.equal(androidStore.getSnapshot().service?.sequence, 9);
    sources[1].emit("android.snapshot", {
      protocolVersion: 4,
      serviceEpoch: "epoch-a",
      sequence: 10,
      serviceRevision: 10,
      type: "android.snapshot",
      payload: { runner: snapshot(10).runner },
    });
    assert.equal(androidStore.getSnapshot().service?.sequence, 9);
    androidStore.dispose();
    store = undefined;
    assert.equal(sources[2].closed, true);
  } finally {
    store?.dispose();
    await vite.close();
  }
});
