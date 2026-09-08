import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { KeyboardRevisionConflict, KeyboardSettingsStore } from "../src/server/keyboard-settings.ts";
import {
  assignBinding,
  DEFAULT_KEYMAP,
  defaultBinding,
  DoubleShift,
  effectiveBinding,
  eventBinding,
  matchesBinding,
  validateKeymap,
  type Binding,
  type Keymap,
  type KeyStroke,
} from "../src/shared/keyboard.ts";

const chord = (key: string, ...modifiers: ("Mod" | "Ctrl" | "Meta" | "Alt" | "Shift")[]): Binding => ({
  kind: "chord",
  key,
  modifiers,
});
const stroke = (key: string, extra: Partial<KeyStroke> = {}): KeyStroke => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

test("SQLite preserves overrides/unbinding across restart and CAS prevents two connections losing edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "pylon-keyboard-"));
  const path = join(dir, "preferences", "settings.sqlite");
  let first: KeyboardSettingsStore | undefined;
  let second: KeyboardSettingsStore | undefined;
  try {
    first = new KeyboardSettingsStore(path);
    second = new KeyboardSettingsStore(path);
    const base = second.read();
    const assigned = assignBinding(base.keymap, "theme", chord("P", "Mod"));
    assert.deepEqual(assigned.lost, ["find-file"]);
    const saved = first.update(0, assigned.keymap);
    assert.equal(effectiveBinding(saved.keymap, "find-file"), null);
    assert.throws(() => second!.update(base.revision, { preset: "vscode", overrides: {} }), KeyboardRevisionConflict);
    assert.deepEqual(second.read(), saved);
    const beforeFailure = second.read();
    assert.throws(
      () => second!.update(saved.revision, { preset: "pylon", overrides: { theme: chord("T", "Mod") } }),
      /Reserved/,
    );
    assert.deepEqual(second.read(), beforeFailure);
    first.close();
    first = undefined;
    second.close();
    second = new KeyboardSettingsStore(path);
    assert.deepEqual(second.read(), saved);
    const reset = assignBinding(saved.keymap, "theme", defaultBinding("theme", "pylon")).keymap;
    delete reset.overrides.theme;
    assert.equal(Object.hasOwn(second.update(saved.revision, reset).keymap.overrides, "theme"), false);
    assert.equal(effectiveBinding(second.read().keymap, "find-file"), null);
    second.close();
    second.close();
    assert.throws(() => second!.update(2, DEFAULT_KEYMAP), /closed/);
  } finally {
    first?.close();
    second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported or damaged persistent settings fail closed without replacing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "pylon-keyboard-corrupt-"));
  const path = join(dir, "settings.sqlite");
  try {
    new KeyboardSettingsStore(path).close();
    let db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=2");
    db.close();
    assert.throws(() => new KeyboardSettingsStore(path), /newer/);
    db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=1; UPDATE keyboard_settings SET value='broken'");
    db.close();
    assert.throws(() => new KeyboardSettingsStore(path));
    db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT value FROM keyboard_settings").get()?.value, "broken");
    db.exec("DELETE FROM keyboard_settings");
    db.close();
    assert.throws(() => new KeyboardSettingsStore(path), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assignments and resets evict only overlapping contexts, including platform-specific primary aliases", () => {
  let map = assignBinding(DEFAULT_KEYMAP, "reveal", chord("F8")).keymap;
  const local = assignBinding(map, "send", chord("F8"));
  assert.deepEqual(local.lost, []); // Composer and explorer cannot own focus simultaneously.
  map = assignBinding(local.keymap, "theme", chord("F8")).keymap;
  assert.equal(effectiveBinding(map, "reveal"), null);
  assert.deepEqual(effectiveBinding(map, "send"), chord("F8")); // Theme yields in text inputs.
  const moved = assignBinding(DEFAULT_KEYMAP, "find-symbol", chord("P", "Ctrl"));
  assert.deepEqual(moved.lost, ["find-file"]); // Conflicts on Windows even when recorded on a Mac.
  const restored = assignBinding(moved.keymap, "find-file", defaultBinding("find-file", "pylon"));
  delete restored.keymap.overrides["find-file"];
  assert.deepEqual(restored.lost, ["find-symbol"]);
  assert.equal(validateKeymap(restored.keymap), undefined);
  assert.throws(() => assignBinding(DEFAULT_KEYMAP, "theme", chord("A")), /Typing/);
  assert.throws(() => assignBinding(DEFAULT_KEYMAP, "theme", chord("Tab")), /reserved/);
  const invalid: Keymap = { preset: "pylon", overrides: { "find-symbol": chord("P", "Ctrl") } };
  assert.match(validateKeymap(invalid)!, /conflicts/); // Direct persistence cannot bypass the assignment path.
});

test("logical primary bindings match exact modifiers without swallowing IME, repeats, AltGraph or handled keys", () => {
  const plus = eventBinding(stroke("+", { ctrlKey: true, shiftKey: true }), false)!;
  assert.deepEqual(plus, chord("+", "Mod", "Shift"));
  assert.equal(matchesBinding(stroke("+", { ctrlKey: true, shiftKey: true }), plus, false), true);
  assert.equal(matchesBinding(stroke("+", { metaKey: true, shiftKey: true }), plus, true), true);
  assert.equal(matchesBinding(stroke("+", { ctrlKey: true, shiftKey: true }), plus, true), false);
  const key = chord("P", "Mod");
  for (const extra of [
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { defaultPrevented: true },
    { getModifierState: () => true },
  ]) {
    assert.equal(matchesBinding(stroke("p", { ctrlKey: true, ...extra }), key, false), false);
  }
  assert.equal(eventBinding(stroke("Dead"), false), undefined);
  assert.equal(matchesBinding(stroke("Enter"), null, false), false);
});

test("double Shift requires two releases and cancels on intervening input, hold, composition, blur and expiry", () => {
  const taps = new DoubleShift();
  const shift = stroke("Shift", { shiftKey: true });
  const tap = (at: number) => {
    assert.equal(taps.handle(shift, "keydown", at), false);
    return taps.handle(stroke("Shift"), "keyup", at + 10);
  };
  assert.equal(tap(100), false);
  assert.equal(tap(250), true);
  assert.equal(tap(400), false);
  taps.handle(stroke("x"), "keydown", 450);
  assert.equal(tap(500), false);
  taps.reset();
  assert.equal(tap(700), false);
  taps.handle({ ...shift, repeat: true }, "keydown", 720);
  assert.equal(tap(750), false);
  taps.reset();
  assert.equal(tap(900), false);
  taps.handle({ ...shift, isComposing: true }, "keydown", 920);
  assert.equal(tap(950), false);
  taps.reset();
  assert.equal(tap(1100), false);
  taps.reset();
  assert.equal(tap(1200), false);
  assert.equal(tap(1800), false);
  assert.equal(tap(1900), true);
  taps.handle(shift, "keydown", 2000);
  assert.equal(taps.handle(stroke("Shift"), "keyup", 5000), false);
  assert.equal(tap(5100), false); // Modifier keys need not auto-repeat while held.
});
