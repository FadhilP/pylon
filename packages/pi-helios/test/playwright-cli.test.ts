import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePngFile } from "../src/capture.ts";
import { elementReferences, isElementReference } from "../src/element-ref.ts";
import { compactSnapshotLines, PlaywrightCli, HeliosCliError, validateNavigationUrl } from "../src/playwright-cli.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SESSION = "helios-0123456789ab-0123456789ab";
const OTHER_SESSION = "helios-fedcba987654-fedcba987654";

test("element references accept Playwright namespaces without broadening the grammar", () => {
  for (const ref of ["e1", "f1e41", "f000e0"]) assert.equal(isElementReference(ref), true);
  for (const ref of ["f1", "fe1", "f1e", "f1f2e3", "f1e2x", "xf1e2"]) assert.equal(isElementReference(ref), false);
  const snapshot = "- button [ref=f1e41]\n- link [ref=e2]\n- text: ref=f2e3\n- button [ref=f1f2e3]";
  assert.deepEqual(elementReferences(snapshot), ["f1e41", "e2"]);
  assert.deepEqual(elementReferences(snapshot), ["f1e41", "e2"]);
});

test("snapshot compactor flattens only exact anonymous generic wrappers", () => {
  const raw = [
    "- generic [ref=e1]:",
    "  - generic [ref=f1e2]:",
    '    - button "Go" [ref=f1e3] [cursor=pointer]',
    '  - generic "Named" [ref=e4]:',
    "    - text: Keep",
    "  - generic [ref=e5] [cursor=pointer]:",
    "    - text: Clickable",
    "  - generic [ref=e6]",
    "  - main [ref=e7]:",
    "    - generic [ref=e8]:",
    '      - link "Docs" [ref=e9]',
  ];
  assert.deepEqual(compactSnapshotLines(raw), [
    '- button "Go" [ref=f1e3] [cursor=pointer]',
    '- generic "Named" [ref=e4]:',
    "  - text: Keep",
    "- generic [ref=e5] [cursor=pointer]:",
    "  - text: Clickable",
    "- main [ref=e7]:",
    '  - link "Docs" [ref=e9]',
  ]);

  for (const malformed of [
    ["- generic [ref=e1]:", "\t- button Tabbed [ref=e2]"],
    ["- generic [ref=e1]:", "   - button Odd [ref=e2]"],
  ]) assert.deepEqual(compactSnapshotLines(malformed), malformed);
});

test("adapter invokes pinned CLI with argument array and private cwd", async () => {
  let call: { command: string; args: string[]; options: any } | undefined;
  const cli = await PlaywrightCli.create(async (command, args, options) => {
    call = { command, args, options };
    return { code: 0, stdout: JSON.stringify({ snapshot: "- heading [ref=e1]" }), stderr: "", killed: false };
  });
  try {
    const result = await cli.run(SESSION, { kind: "snapshot", depth: 3 });
    assert.equal(call!.command, process.execPath);
    assert.match(call!.args[0], /@playwright[\\/]cli[\\/]playwright-cli\.js$/);
    assert.deepEqual(call!.args.slice(1), ["--json", `-s=${SESSION}`, "snapshot", "--depth=3"]);
    assert.equal(call!.options.cwd, cli.directory);
    assert.equal(result.snapshot, "- heading [ref=e1]");
    assert.equal(result.value.snapshot, undefined);
  } finally { await cli.dispose(); }
});

test("artifact reads stay inside the private directory and enforce the byte cap", async () => {
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }));
  const outside = await mkdtemp(join(tmpdir(), "helios-artifact-outside-"));
  try {
    const frame = join(cli.directory, "artifacts", "frame.png");
    const escaped = join(outside, "frame.png");
    await writeFile(frame, PNG);
    await writeFile(escaped, PNG);
    assert.equal((await cli.readArtifact(frame, PNG.length)).equals(PNG), true);
    await assert.rejects(cli.readArtifact(frame, PNG.length - 1), /oversized/);
    await assert.rejects(cli.readArtifact(escaped, PNG.length), /artifact path/);
  } finally {
    await cli.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test("find uses bounded CLI snapshot search output", async () => {
  const calls: string[][] = [];
  const found = 'Found 1 match for "Add to cart":\n\n- button "Add to cart" [ref=e9]';
  const cli = await PlaywrightCli.create(async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ result: found }), stderr: "", killed: false };
  });
  try {
    const text = await cli.run(SESSION, { kind: "find", text: "Add to cart" });
    const regex = await cli.run(SESSION, { kind: "find", regex: "/add to cart/i" });
    assert.deepEqual(calls[0].slice(1), ["--json", `-s=${SESSION}`, "find", "Add to cart"]);
    assert.deepEqual(calls[1].slice(1), ["--json", `-s=${SESSION}`, "find", "--regex", "/add to cart/i"]);
    assert.equal(text.snapshot, found);
    assert.equal(text.value.result, undefined);
    assert.equal(text.findMatches, 1);
    assert.equal(regex.snapshot, found);
    assert.equal(regex.findMatches, 1);
    await assert.rejects(cli.run(SESSION, { kind: "find" }), /exactly one/);
    await assert.rejects(cli.run(SESSION, { kind: "find", text: "x", regex: "x" }), /exactly one/);
  } finally { await cli.dispose(); }
});

test("find match count ignores page content after the result header", async () => {
  const raw = "- text no summary header\nFound 999 matches in page content";
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ result: raw }), stderr: "", killed: false }));
  try {
    const result = await cli.run(SESSION, { kind: "find", text: "Found" });
    assert.equal(result.findMatches, undefined);
  } finally { await cli.dispose(); }
});

test("find redacts secrets and drops raw string results", async () => {
  const raw = 'Found 1 match for "Password":\n\n- textbox "Password" [ref=e7]: hunter2';
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ result: raw }), stderr: "", killed: false }));
  try {
    const result = await cli.run(SESSION, { kind: "find", text: "Password" });
    assert.match(result.snapshot!, /value redacted/);
    assert.doesNotMatch(JSON.stringify(result), /hunter2/);
    assert.equal(result.value.result, undefined);
  } finally { await cli.dispose(); }
});

test("link URL lookup uses fixed trusted expression and snapshot reference", async () => {
  let args: string[] = [];
  const cli = await PlaywrightCli.create(async (_command, value) => {
    args = value;
    return { code: 0, stdout: JSON.stringify({ result: "https://example.com/docs" }), stderr: "", killed: false };
  });
  try {
    await cli.run(SESSION, { kind: "link-url", target: "f1e7" });
    assert.deepEqual(args.slice(1), ["--json", `-s=${SESSION}`, "eval", "el => el instanceof HTMLAnchorElement ? el.href : ''", "f1e7"]);
    for (const target of ["#link", "f1", "fe1", "f1e", "f1f2e3", "f1e2x"]) {
      await assert.rejects(cli.run(SESSION, { kind: "link-url", target }), /snapshot reference/);
    }
  } finally { await cli.dispose(); }
});

test("owned visibility controls config and headed CLI flag", async () => {
  let args: string[] = [];
  const cli = await PlaywrightCli.create(async (_command, value) => {
    args = value;
    return { code: 0, stdout: "{}", stderr: "", killed: false };
  });
  try {
    await cli.configureOwned(`${cli.directory}/profile`, false);
    await cli.run(SESSION, { kind: "open", profileDirectory: `${cli.directory}/profile`, headed: false });
    assert.ok(!args.includes("--headed"));
    const configArg = args.find((arg) => arg.startsWith("--config="));
    assert.ok(configArg);
    const config = JSON.parse(await readFile(configArg.slice("--config=".length), "utf8"));
    assert.equal(config.browser.launchOptions.headless, true);
  } finally { await cli.dispose(); }
});

test("adapter rejects unsafe inputs and malformed or oversized output", async () => {
  assert.throws(() => validateNavigationUrl("file:///secret"), /HTTP/);
  assert.throws(() => validateNavigationUrl("http://user:pass@localhost"), /credentials/);
  const malformed = await PlaywrightCli.create(async () => ({ code: 0, stdout: "not json", stderr: "", killed: false }));
  await assert.rejects(malformed.run(SESSION, { kind: "tab-list" }), (error: any) => error instanceof HeliosCliError && error.category === "invalid-output");
  await malformed.dispose();
  const oversized = await PlaywrightCli.create(async () => ({ code: 0, stdout: "x".repeat(300_000), stderr: "", killed: false }));
  await assert.rejects(oversized.run(SESSION, { kind: "tab-list" }), /256KB/);
  await oversized.dispose();

  for (const bytes of [0, 1, 2, 3]) {
    await assert.rejects(PlaywrightCli.create(async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }), { maxSnapshotBytes: bytes }), /at least 4/);
  }
  await assert.rejects(PlaywrightCli.create(async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }), { maxSnapshotLines: 0 }), /at least 1/);
  await assert.rejects(PlaywrightCli.create(async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }), { maxActionSnapshotLines: 1.5 }), /integer/);
});

test("adapter safely identifies missing browser stderr", async () => {
  const missing = await PlaywrightCli.create(async () => ({
    code: 1,
    stdout: "",
    stderr: 'C:\\private\\session.js:169\nError: Daemon pid=123: exited\nError: Browser "firefox" is not installed. Run `playwright-cli install-browser firefox` to install\n    at C:\\private\\secret.js:1',
    killed: false,
  }));
  await assert.rejects(missing.run(SESSION, { kind: "open", profileDirectory: missing.directory, headed: false }), (error: any) => {
    assert.equal(error.category, "command-failed");
    assert.equal(error.message, "Playwright browser is not installed; run the matching `playwright-cli install-browser` setup command");
    assert.doesNotMatch(error.message, /private|secret|pid=123/i);
    return true;
  });
  await missing.dispose();

  for (const stderr of ["", "Error: launch failed for token=secret-value", 'Browser "firefox" may not be installed', 'Error: Browser "firefox" is not installed. Run `playwright-cli install-browser chrome` to install']) {
    const unknown = await PlaywrightCli.create(async () => ({ code: 1, stdout: "", stderr, killed: false }));
    await assert.rejects(unknown.run(SESSION, { kind: "tab-list" }), (error: any) => error.message === "Playwright CLI command failed");
    await unknown.dispose();
  }

  const oversized = await PlaywrightCli.create(async () => ({ code: 1, stdout: "", stderr: "x".repeat(17 * 1024), killed: false }));
  await assert.rejects(oversized.run(SESSION, { kind: "tab-list" }), /16KB limit/);
  await oversized.dispose();
});

test("adapter classifies only the pinned missing-session error", async () => {
  const missing = await PlaywrightCli.create(async () => ({ code: 1, stdout: JSON.stringify({ isError: true, error: `The browser '${SESSION}' is not open, please run open first` }), stderr: "", killed: false }));
  await assert.rejects(missing.run(SESSION, { kind: "reload" }), (error: any) => error.category === "session-missing");
  await missing.dispose();

  const nearMatch = await PlaywrightCli.create(async () => ({ code: 1, stdout: JSON.stringify({ isError: true, error: `The browser '${SESSION}' is not open; please run open first` }), stderr: "", killed: false }));
  await assert.rejects(nearMatch.run(SESSION, { kind: "reload" }), (error: any) => error.category === "command-failed");
  await nearMatch.dispose();
});

test("adapter maps timeout and cancellation without leaking subprocess details", async () => {
  const timed = await PlaywrightCli.create(async () => ({ code: 1, stdout: "{}", stderr: "private failure", killed: true }));
  await assert.rejects(timed.run(SESSION, { kind: "reload" }), (error: any) => error.category === "timeout");
  await timed.dispose();

  let invoked = false;
  const cancelled = await PlaywrightCli.create(async () => { invoked = true; return { code: 0, stdout: "{}", stderr: "", killed: false }; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancelled.run(SESSION, { kind: "reload" }, controller.signal), (error: any) => error.category === "cancelled");
  assert.equal(invoked, false);
  await cancelled.dispose();
});

test("adapter validates screenshot and redacts credentials in bounded snapshots", async () => {
  const cli = await PlaywrightCli.create(async (_command, args) => {
    const filename = args.find((arg) => arg.startsWith("--filename="))?.slice("--filename=".length);
    if (filename) await writeFile(filename, PNG);
    return { code: 0, stdout: JSON.stringify({ snapshot: '- textbox "Password" [ref=f1e7]: hunter2\r\n- searchbox "Search" [ref=f2e8]: private query\r\n- combobox "Plan" [ref=f3e9]: Enterprise\r\n- spinbutton "Seats" [ref=f4e10]: 10\r\n- button "Keep" [ref=f4e11]: visible\r\n- text: token=ghp_abcdefghijklmnopqrstuvwxyz\r\n- text: Authorization: Bearer secret-value' }), stderr: "", killed: false };
  });
  try {
    const shot = await cli.run(SESSION, { kind: "screenshot" });
    assert.ok(shot.artifactPath);
    const snapshot = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(snapshot.snapshot, '- textbox "Password" [ref=f1e7]: [value redacted]\n- searchbox "Search" [ref=f2e8]: [value redacted]\n- combobox "Plan" [ref=f3e9]: [value redacted]\n- spinbutton "Seats" [ref=f4e10]: [value redacted]\n- button "Keep" [ref=f4e11]: visible\n- text: [possible credential redacted]\n- text: [possible credential redacted]');
    assert.equal(snapshot.snapshotRedactions, 6);
    assert.equal(snapshot.snapshotTruncated, false);
    await assert.rejects(cli.run(SESSION, { kind: "click", target: "#submit" }), /snapshot reference/);
  } finally { await cli.dispose(); }
});

test("snapshots compact by default while full mode preserves structure and redaction", async () => {
  const raw = '- generic [ref=e1]:\n  - textbox "Password" [ref=f1e2]: hunter2';
  const calls: string[][] = [];
  const cli = await PlaywrightCli.create(async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false };
  });
  try {
    const compact = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(compact.snapshot, '- textbox "Password" [ref=f1e2]: [value redacted]');
    assert.equal(compact.snapshotRedactions, 1);

    const full = await cli.run(SESSION, { kind: "snapshot", snapshotMode: "full" });
    assert.equal(full.snapshot, '- generic [ref=e1]:\n  - textbox "Password" [ref=f1e2]: [value redacted]');
    assert.equal(full.snapshotRedactions, 1);

    const action = await cli.run(SESSION, { kind: "navigate", url: "https://example.com" });
    assert.equal(action.snapshot, '- textbox "Password" [ref=f1e2]: [value redacted]');
    assert.equal(calls.every((args) => !args.includes("compact") && !args.includes("full")), true);
  } finally { await cli.dispose(); }
});

test("continuation caches compacted structure and reports compacted counts", async () => {
  const raw = Array.from({ length: 4 }, (_, index) => `- generic [ref=e${index * 2 + 1}]:\n  - button Item ${index} [ref=e${index * 2 + 2}]`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false }), { maxSnapshotLines: 2, maxSnapshotBytes: 1024 });
  try {
    const first = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(first.snapshot, "- button Item 0 [ref=e2]\n- button Item 1 [ref=e4]");
    assert.equal(first.snapshotOmittedLines, 2);
    const second = await cli.run(SESSION, { kind: "continue", cursor: first.snapshotContinuation! });
    assert.equal(second.snapshot, "- button Item 2 [ref=e6]\n- button Item 3 [ref=e8]");
    assert.equal(second.snapshotTruncated, false);
  } finally { await cli.dispose(); }
});

test("action-specific snapshot limits report deterministic omitted counts", async () => {
  const raw = Array.from({ length: 505 }, (_, index) => `- text line ${index}`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false }));
  try {
    const snapshot = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(snapshot.snapshotTruncated, true);
    assert.equal(snapshot.snapshotOmittedLines, 305);
    assert.ok((snapshot.snapshotOmittedBytes ?? 0) > 0);
    assert.equal(snapshot.snapshot?.split("\n").length, 200);

    const action = await cli.run(SESSION, { kind: "navigate", url: "https://example.com" });
    assert.equal(action.snapshotOmittedLines, 405);
    assert.equal(action.snapshot?.split("\n").length, 100);
  } finally { await cli.dispose(); }
});

test("continuation pages cached redacted output without another browser command", async () => {
  const raw = [
    "- heading First [ref=e1]",
    "- link Second [ref=e2]",
    '- textbox "Password" [ref=e3]: hunter2',
    "- button Fourth [ref=e4]",
    "- link Fifth [ref=e5]",
    "- button Sixth [ref=e6]",
  ].join("\n");
  let calls = 0;
  const cli = await PlaywrightCli.create(async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify(calls === 1 ? { snapshot: raw } : { result: "- 0: (current) [Example](https://example.com/)" }), stderr: "", killed: false };
  }, { maxSnapshotLines: 2, maxSnapshotBytes: 1024 });
  try {
    const first = await cli.run(SESSION, { kind: "snapshot" });
    assert.match(first.snapshot!, /ref=e1/);
    assert.match(first.snapshot!, /ref=e2/);
    assert.ok(first.snapshotContinuation);

    await assert.rejects(cli.run(OTHER_SESSION, { kind: "continue", cursor: first.snapshotContinuation! }), /stale/);
    await cli.run(SESSION, { kind: "tab-list" });
    const second = await cli.run(SESSION, { kind: "continue", cursor: first.snapshotContinuation! });
    assert.equal(calls, 2);
    assert.doesNotMatch(second.snapshot!, /hunter2/);
    assert.match(second.snapshot!, /value redacted/);
    assert.match(second.snapshot!, /ref=e4/);
    assert.ok(second.snapshotContinuation);
    await assert.rejects(cli.run(SESSION, { kind: "continue", cursor: first.snapshotContinuation! }), /stale/);

    const third = await cli.run(SESSION, { kind: "continue", cursor: second.snapshotContinuation! });
    assert.match(third.snapshot!, /ref=e5/);
    assert.match(third.snapshot!, /ref=e6/);
    assert.equal(third.snapshotTruncated, false);
    assert.equal(third.snapshotContinuation, undefined);
    assert.equal(calls, 2);
  } finally { await cli.dispose(); }
});

test("continuation progresses across oversized multibyte lines", async () => {
  const raw = `${"é".repeat(100)}\n- button End [ref=e9]`;
  let calls = 0;
  const cli = await PlaywrightCli.create(async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false };
  }, { maxSnapshotLines: 1, maxSnapshotBytes: 40 });
  try {
    let result = await cli.run(SESSION, { kind: "snapshot" });
    let pages = 1;
    while (result.snapshotContinuation) {
      assert.ok(Buffer.byteLength(result.snapshot!) <= 40);
      result = await cli.run(SESSION, { kind: "continue", cursor: result.snapshotContinuation });
      if (++pages > 20) assert.fail("continuation did not progress");
    }
    assert.match(result.snapshot!, /ref=e9/);
    assert.equal(calls, 1);
  } finally { await cli.dispose(); }
});

test("disposing adapter clears pending continuation", async () => {
  const raw = "- button One [ref=e1]\n- button Two [ref=e2]";
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false }), { maxSnapshotLines: 1 });
  const result = await cli.run(SESSION, { kind: "snapshot" });
  assert.ok(result.snapshotContinuation);
  await cli.dispose();
  await assert.rejects(cli.run(SESSION, { kind: "continue", cursor: result.snapshotContinuation! }), /stale/);
});

test("page-changing and replacement actions invalidate continuation", async () => {
  const raw = Array.from({ length: 5 }, (_, index) => `- button ${index} [ref=e${index}]`).join("\n");
  let failNavigate = false;
  const cli = await PlaywrightCli.create(async (_command, args) => {
    if (args.includes("goto") && failNavigate) return { code: 1, stdout: "", stderr: "failed", killed: false };
    return { code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false };
  }, { maxSnapshotLines: 2, maxSnapshotBytes: 1024 });
  try {
    const first = await cli.run(SESSION, { kind: "snapshot" });
    const replacement = await cli.run(SESSION, { kind: "snapshot" });
    await assert.rejects(cli.run(SESSION, { kind: "continue", cursor: first.snapshotContinuation! }), /stale/);

    failNavigate = true;
    await assert.rejects(cli.run(SESSION, { kind: "navigate", url: "https://example.com" }), /command failed/i);
    await assert.rejects(cli.run(SESSION, { kind: "continue", cursor: replacement.snapshotContinuation! }), /stale/);
  } finally { await cli.dispose(); }
});

test("find has a smaller cap and preserves total match count", async () => {
  const raw = [`Found 140 matches for /item/:`, "", ...Array.from({ length: 140 }, (_, index) => `- button item ${index} [ref=e${index}]`)].join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ result: raw }), stderr: "", killed: false }));
  try {
    const result = await cli.run(SESSION, { kind: "find", regex: "/item/" });
    assert.equal(result.findMatches, 140);
    assert.equal(result.snapshotTruncated, true);
    assert.equal(result.snapshot?.split("\n").length, 120);
    assert.equal(result.snapshotOmittedLines, 22);
    assert.equal(result.value.result, undefined);
  } finally { await cli.dispose(); }
});

test("custom snapshot limits bound Web Scout output", async () => {
  const raw = Array.from({ length: 10 }, (_, index) => `- link ${index} [ref=e${index}]`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ result: { snapshot: raw } }), stderr: "", killed: false }), {
    maxSnapshotLines: 2,
    maxSnapshotBytes: 1024,
    maxActionSnapshotLines: 2,
    maxActionSnapshotBytes: 64,
  });
  try {
    const result = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(result.snapshot?.split("\n").length, 2);
    assert.equal(result.snapshotOmittedLines, 8);
    assert.equal((result.value.result as Record<string, unknown>).snapshot, undefined);

    const action = await cli.run(SESSION, { kind: "navigate", url: "https://example.com" });
    assert.match(action.snapshot!, /ref=e0/);
    assert.match(action.snapshot!, /ref=e1/);
    assert.equal(action.snapshotOmittedLines, 8);
  } finally { await cli.dispose(); }
});

test("snapshot byte limits count multibyte text", async () => {
  const raw = Array.from({ length: 4 }, () => `- ${"é".repeat(100)}`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false }), { maxSnapshotLines: 100, maxSnapshotBytes: 250 });
  try {
    const result = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(result.snapshot?.split("\n").length, 1);
    assert.equal(result.snapshotOmittedLines, 3);
    assert.equal(result.snapshotTruncated, true);
    assert.ok((result.snapshotOmittedBytes ?? 0) > 600);
    assert.ok(Buffer.byteLength(result.snapshot!) <= 250);
  } finally { await cli.dispose(); }
});

test("PNG file validation reads only metadata and signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helios-png-test-"));
  try {
    const valid = join(directory, "valid.png");
    await writeFile(valid, PNG);
    await validatePngFile(valid);

    const invalid = join(directory, "invalid.png");
    await writeFile(invalid, "not png");
    await assert.rejects(validatePngFile(invalid), /did not produce a PNG/);

    const oversized = join(directory, "oversized.png");
    await writeFile(oversized, PNG.subarray(0, 8));
    await truncate(oversized, 25 * 1024 * 1024 + 1);
    await assert.rejects(validatePngFile(oversized), /exceeds 25MB/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
