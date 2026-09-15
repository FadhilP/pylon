import test from "node:test";
import assert from "node:assert/strict";
import { terminalShell, terminalShellArgs } from "../src/server/http/terminal.ts";

test("macOS terminals use an executable interactive login shell", () => {
  const executable = new Set(["/bin/zsh", "/bin/sh"]);
  const canExecute = (path: string) => executable.has(path);

  assert.equal(terminalShell("darwin", { SHELL: "/missing/custom-shell" }, canExecute), "/bin/zsh");
  assert.equal(terminalShell("darwin", { SHELL: "/bin/sh" }, canExecute), "/bin/sh");
  assert.deepEqual(terminalShellArgs("darwin", "/bin/zsh"), ["-l", "-i"]);
  assert.deepEqual(terminalShellArgs("darwin", "/opt/homebrew/bin/fish"), ["-l", "-i"]);
  assert.deepEqual(terminalShellArgs("darwin", "/bin/bash"), ["-l", "-i"]);
  assert.deepEqual(terminalShellArgs("darwin", "/bin/sh"), ["-l", "-i"]);
  assert.deepEqual(terminalShellArgs("darwin", "/usr/local/bin/custom-shell"), []);
  assert.deepEqual(terminalShellArgs("linux", "/bin/zsh"), []);
});
