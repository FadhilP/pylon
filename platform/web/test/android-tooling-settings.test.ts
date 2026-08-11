import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Helios package settings expose confirmed local Android tooling controls", async () => {
  const [settings, app] = await Promise.all([
    readFile(new URL("../src/client/settings-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /selectedPackage\.id === "pi-helios"[\s\S]*?AndroidToolingSettings/);
  assert.match(settings, /Android tooling[\s\S]*?Appium[\s\S]*?UiAutomator2/);
  assert.match(settings, /role="alertdialog"[\s\S]*?repository-pinned npm packages[\s\S]*?>Confirm</);
  assert.match(settings, /No global packages or emulator data are changed/);
  assert.match(settings, /state === "ready" \|\| status\?\.state === "invalid" \? "Repair" : "Install"/);
  assert.match(settings, /Android SDK, Java, and an AVD are still required/);
  assert.match(settings, /`target \$\{value \?\? fallback\}`/);
  assert.doesNotMatch(settings, /window\.confirm/);
  assert.match(app, /heliosAndroidTooling\(action === "status" \? \{ action \} : \{ action, confirmed: true \}\)/);
});
