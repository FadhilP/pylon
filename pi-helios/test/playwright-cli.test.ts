import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
