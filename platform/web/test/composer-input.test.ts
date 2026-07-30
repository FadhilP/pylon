import test from "node:test";
import assert from "node:assert/strict";
import { fileMentionAtCaret, isNearTranscriptBottom, loginCommandProvider, replaceFileMention } from "../src/shared/composer-input.ts";

test("file mentions follow the caret and quote paths containing spaces", () => {
  const value = "Compare @src/fo with @ignored";
  const mention = fileMentionAtCaret(value, "Compare @src/fo".length);
  assert.deepEqual(mention, { start: 8, end: 15, query: "src/fo" });
  assert.deepEqual(replaceFileMention(value, mention!, "src/foo bar.ts"), {
    value: "Compare @\"src/foo bar.ts\" with @ignored",
    caret: 25,
  });
  assert.equal(fileMentionAtCaret("mail@example.com", 16), undefined);
  assert.equal(fileMentionAtCaret("Read @\"src/foo bar", 18)?.query, "src/foo bar");
  assert.equal(fileMentionAtCaret("Read (@src", 10)?.query, "src");
});

test("login command parsing only intercepts the exact local command", () => {
  assert.equal(loginCommandProvider("/login"), undefined);
  assert.equal(loginCommandProvider(" /LOGIN anthropic "), "anthropic");
  assert.equal(loginCommandProvider("please /login"), null);
  assert.equal(loginCommandProvider("/login anthropic now\nextra"), null);
});

test("transcript bottom detection uses the requested follow threshold", () => {
  assert.equal(isNearTranscriptBottom({ scrollHeight: 1_000, scrollTop: 452, clientHeight: 500 }), true);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 1_000, scrollTop: 451, clientHeight: 500 }), false);
});
