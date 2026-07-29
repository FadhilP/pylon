import assert from "node:assert/strict";
import test from "node:test";
import { parseTerminalMessage, terminalShell } from "../src/server/http/terminal.ts";

test("terminal uses PowerShell on Windows for interactive syntax colors", () => {
  assert.equal(terminalShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }), "powershell.exe");
  assert.equal(terminalShell("linux", { SHELL: "/bin/zsh" }), "/bin/zsh");
});

test("terminal protocol accepts bounded input and resize messages", () => {
  assert.deepEqual(parseTerminalMessage({ type: "input", data: "echo ok\r" }), { type: "input", data: "echo ok\r" });
  assert.deepEqual(parseTerminalMessage({ type: "resize", cols: 120, rows: 40 }), { type: "resize", cols: 120, rows: 40 });
});

test("terminal protocol rejects malformed and unbounded messages", () => {
  for (const value of [
    null,
    { type: "input", data: 1 },
    { type: "input", data: "x".repeat(65_537) },
    { type: "resize", cols: 1, rows: 40 },
    { type: "resize", cols: 120, rows: 301 },
    { type: "resize", cols: 120.5, rows: 40 },
    { type: "unknown" },
  ]) assert.equal(parseTerminalMessage(value), undefined);
});
