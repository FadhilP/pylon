import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDROID_OUTPUT_SPLIT_KEY,
  DEFAULT_ANDROID_DOCK_LAYOUT,
  androidRunPhaseStep,
  closeTerminalTab,
  dockAndroidOutput,
  moveAndroidOutputSplit,
  readAndroidOutputSplit,
  restoreAndroidOutput,
} from "../src/client/android/android-layout.ts";

test("Android outputs dock and restore independently with a valid active fallback", () => {
  const buildDocked = dockAndroidOutput(DEFAULT_ANDROID_DOCK_LAYOUT, "build");
  assert.deepEqual(buildDocked, { build: true, logs: false, active: "build" });

  const bothDocked = dockAndroidOutput(buildDocked, "logs");
  assert.deepEqual(bothDocked, { build: true, logs: true, active: "logs" });

  const logsRestored = restoreAndroidOutput(bothDocked, "logs");
  assert.deepEqual(logsRestored, { build: true, logs: false, active: "build" });
  assert.deepEqual(restoreAndroidOutput(logsRestored, "build"), DEFAULT_ANDROID_DOCK_LAYOUT);

  assert.deepEqual(closeTerminalTab({ build: false, logs: true, active: "terminal" }), {
    build: false,
    logs: true,
    active: "logs",
  });
});

test("Android run phases preserve progress and identify the failed lifecycle step", () => {
  assert.deepEqual(androidRunPhaseStep("building", { buildSucceeded: false, hasArtifact: false, installed: false }), {
    at: 0,
    tone: "active",
  });
  assert.deepEqual(androidRunPhaseStep("running", { buildSucceeded: true, hasArtifact: true, installed: true }), {
    at: 4,
    tone: "active",
  });
  assert.deepEqual(androidRunPhaseStep("failed", { buildSucceeded: true, hasArtifact: true, installed: false }), {
    at: 2,
    tone: "danger",
  });
  assert.deepEqual(androidRunPhaseStep("cancelled", { buildSucceeded: true, hasArtifact: true, installed: true }), {
    at: 3,
    tone: "warning",
  });
});

test("Android output split accepts bounded persistence and keyboard resizing never resets it", () => {
  const storage = {
    getItem(key: string) {
      assert.equal(key, ANDROID_OUTPUT_SPLIT_KEY);
      return "0.63";
    },
  };
  assert.equal(readAndroidOutputSplit(storage), 0.63);
  assert.equal(readAndroidOutputSplit({ getItem: () => "1" }), undefined);
  assert.equal(readAndroidOutputSplit({ getItem: () => "not-a-number" }), undefined);
  assert.equal(readAndroidOutputSplit({ getItem: () => { throw new Error("blocked"); } }), undefined);

  assert.equal(moveAndroidOutputSplit(0.63, "ArrowUp"), 0.6);
  assert.equal(moveAndroidOutputSplit(0.63, "ArrowDown", true), 0.73);
  assert.equal(moveAndroidOutputSplit(0.63, "Home"), 0.1);
  assert.equal(moveAndroidOutputSplit(0.63, "End"), 0.9);
  assert.equal(moveAndroidOutputSplit(0.63, "Escape"), undefined);
});
