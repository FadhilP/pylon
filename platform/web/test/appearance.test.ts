import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME,
  readStoredThemePreference,
  rememberStoredPreference,
  rememberThemePreference,
  resolveTheme,
  THEME_KEY,
  type PreferenceStorage,
} from "../src/shared/appearance.ts";
import {
  DEFAULT_SYNTAX_THEME_PREFERENCE,
  readSyntaxThemePreference,
  resolveSyntaxTheme,
  SYNTAX_THEME_KEY,
} from "../src/shared/syntax-highlighting.ts";

function storage(): PreferenceStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("system appearance preferences persist while resolving from the current OS", () => {
  const saved = storage();
  rememberThemePreference(saved, "system");
  rememberStoredPreference(saved, SYNTAX_THEME_KEY, DEFAULT_SYNTAX_THEME_PREFERENCE);

  assert.equal(saved.getItem(THEME_KEY), "system");
  assert.equal(readStoredThemePreference(saved), "system");
  assert.equal(resolveTheme(readStoredThemePreference(saved), true), "light");
  assert.equal(resolveTheme(readStoredThemePreference(saved), false), "dark");
  assert.equal(
    resolveSyntaxTheme(readSyntaxThemePreference(saved.getItem(SYNTAX_THEME_KEY)), "warm"),
    "github-light",
  );
  assert.equal(
    resolveSyntaxTheme(readSyntaxThemePreference(saved.getItem(SYNTAX_THEME_KEY)), "dark"),
    "one-dark-pro",
  );
});

test("explicit appearance preferences remain fixed when the OS changes", () => {
  const saved = storage();
  rememberThemePreference(saved, "warm");
  rememberStoredPreference(saved, SYNTAX_THEME_KEY, "dracula");

  assert.equal(readStoredThemePreference(saved), "warm");
  assert.equal(resolveTheme(readStoredThemePreference(saved), true), "warm");
  assert.equal(resolveTheme(readStoredThemePreference(saved), false), "warm");
  assert.equal(
    resolveSyntaxTheme(readSyntaxThemePreference(saved.getItem(SYNTAX_THEME_KEY)), "light"),
    "dracula",
  );
  assert.equal(
    resolveSyntaxTheme(readSyntaxThemePreference(saved.getItem(SYNTAX_THEME_KEY)), "dark"),
    "dracula",
  );
  assert.equal(readStoredThemePreference({ getItem: () => "invalid" }), DEFAULT_THEME);
});
