import test from "node:test";
import assert from "node:assert/strict";
import {
  REDACTION_MARKER,
  redact,
  sanitizeFailureMessage,
} from "../src/redact.ts";

const CONTROL_CHARS = String.fromCharCode(
  0x00,
  0x1f,
  0x7f,
  0x9f,
  0x2028,
  0x2029,
);
const controlCharPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

test("redaction covers every provider key shape and reports a count", () => {
  const secrets = [
    `sk-ant-${"x".repeat(20)}`,
    `ghp_${"x".repeat(20)}`,
    `AIza${"x".repeat(20)}`,
    `xoxb-${"x".repeat(20)}`,
    `glpat-${"x".repeat(20)}`,
    `pk-${"x".repeat(20)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    "api_key=short-but-labelled",
  ];
  for (const secret of secrets) {
    const result = redact(`before ${secret} after`);
    assert.ok(!result.text.includes(secret), secret);
    assert.equal(result.count, 1, secret);
  }
  assert.equal(redact("nothing sensitive here").count, 0);
});

test("broadTokens:false keeps long identifiers but still scrubs provider keys", () => {
  const commit = "a".repeat(40);
  const digest = `sha256-${"b".repeat(50)}`;
  const key = `AIza${"x".repeat(20)}`;
  const prose = `Commit ${commit} with digest ${digest} and key ${key}`;

  const narrow = redact(prose, { broadTokens: false });
  assert.ok(narrow.text.includes(commit), "a commit hash must survive");
  assert.ok(narrow.text.includes(digest), "a content digest must survive");
  assert.ok(!narrow.text.includes(key), "a provider key must not survive");
  assert.equal(narrow.count, 1);

  // The default still scrubs everything long and opaque.
  const broad = redact(prose);
  assert.ok(!broad.text.includes(commit));
  assert.ok(!broad.text.includes(key));
});

test("the marker is not itself re-redacted by a later pattern", () => {
  const once = redact(`ghp_${"x".repeat(20)}`);
  assert.equal(once.text, REDACTION_MARKER);
  assert.equal(once.count, 1);
});

test("failure diagnostics are redacted, flattened, and bounded", () => {
  const secret = `sk-${"x".repeat(40)}`;
  const message = sanitizeFailureMessage(
    `bad\napi_key=${secret}${CONTROL_CHARS}${"z".repeat(600)}`,
    "Delegate failed.",
  );
  assert.ok(message.length <= 500);
  assert.doesNotMatch(message, controlCharPattern);
  assert.ok(!message.includes(secret));
  assert.match(message, /\[possible credential redacted\]/);
  assert.equal(
    sanitizeFailureMessage(
      "authorization: Bearer short-token",
      "Delegate failed.",
    ),
    REDACTION_MARKER,
  );
  assert.equal(
    sanitizeFailureMessage({ private: "value" }, "Delegate failed."),
    "Delegate failed.",
  );
});
