import test from "node:test";
import assert from "node:assert/strict";
import { isExactSlashCommandSelection, loginCommandProvider } from "../src/shared/composer-input.ts";

test("login composer command routes only exact login input and preserves an optional provider query", () => {
  assert.equal(loginCommandProvider("/login"), undefined);
  assert.equal(loginCommandProvider("  /LOGIN   openai  "), "openai");
  assert.equal(loginCommandProvider("/login openai codex"), "openai codex");
  assert.equal(loginCommandProvider("/login-extra"), null);
  assert.equal(loginCommandProvider("explain /login"), null);
});

test("exact selected slash commands submit instead of requiring a completion keystroke", () => {
  assert.equal(isExactSlashCommandSelection("compact", "compact"), true);
  assert.equal(isExactSlashCommandSelection("COMPACT", "compact"), true);
  assert.equal(isExactSlashCommandSelection("comp", "compact"), false);
  assert.equal(isExactSlashCommandSelection("compact", undefined), false);
});
