import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePngFile } from "../src/capture.ts";
import { PlaywrightCli, HeliosCliError, validateNavigationUrl } from "../src/playwright-cli.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SESSION = "helios-0123456789ab-0123456789ab";

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
    assert.equal(regex.snapshot, found);
    await assert.rejects(cli.run(SESSION, { kind: "find" }), /exactly one/);
    await assert.rejects(cli.run(SESSION, { kind: "find", text: "x", regex: "x" }), /exactly one/);
  } finally { await cli.dispose(); }
});

test("link URL lookup uses fixed trusted expression and snapshot reference", async () => {
  let args: string[] = [];
  const cli = await PlaywrightCli.create(async (_command, value) => {
    args = value;
    return { code: 0, stdout: JSON.stringify({ result: "https://example.com/docs" }), stderr: "", killed: false };
  });
  try {
    await cli.run(SESSION, { kind: "link-url", target: "e7" });
    assert.deepEqual(args.slice(1), ["--json", `-s=${SESSION}`, "eval", "el => el instanceof HTMLAnchorElement ? el.href : ''", "e7"]);
    await assert.rejects(cli.run(SESSION, { kind: "link-url", target: "#link" }), /snapshot reference/);
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
    return { code: 0, stdout: JSON.stringify({ snapshot: '- textbox "Password" [ref=e7]: hunter2\r\n- text: token=ghp_abcdefghijklmnopqrstuvwxyz\r\n- text: Authorization: Bearer secret-value' }), stderr: "", killed: false };
  });
  try {
    const shot = await cli.run(SESSION, { kind: "screenshot" });
    assert.ok(shot.artifactPath);
    const snapshot = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(snapshot.snapshot, '- textbox "Password" [ref=e7]: [value redacted]\n- text: [possible credential redacted]\n- text: [possible credential redacted]');
    assert.equal(snapshot.snapshotRedactions, 3);
    assert.equal(snapshot.snapshotTruncated, false);
    await assert.rejects(cli.run(SESSION, { kind: "click", target: "#submit" }), /snapshot reference/);
  } finally { await cli.dispose(); }
});

test("snapshot truncation reports deterministic omitted counts", async () => {
  const raw = Array.from({ length: 505 }, (_, index) => `- text line ${index}`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ snapshot: raw }), stderr: "", killed: false }));
  try {
    const result = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(result.snapshotTruncated, true);
    assert.equal(result.snapshotOmittedLines, 5);
    assert.ok((result.snapshotOmittedBytes ?? 0) > 0);
    assert.match(result.snapshot!, /\[Snapshot truncated by Helios\]$/);
  } finally { await cli.dispose(); }
});

test("custom snapshot limits bound Web Scout output", async () => {
  const raw = Array.from({ length: 10 }, (_, index) => `- link ${index} [ref=e${index}]`).join("\n");
  const cli = await PlaywrightCli.create(async () => ({ code: 0, stdout: JSON.stringify({ result: { snapshot: raw } }), stderr: "", killed: false }), { maxSnapshotLines: 2, maxSnapshotBytes: 1024 });
  try {
    const result = await cli.run(SESSION, { kind: "snapshot" });
    assert.equal(result.snapshot?.split("\n").length, 3);
    assert.equal((result.value.result as Record<string, unknown>).snapshot, undefined);
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
