#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import readline from "node:readline";

const SUPPORTED_CLI_VERSION = "0.1.18";
const SESSION_NAME = /^helios-[a-f0-9]{12}-[a-f0-9]{12}$/;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const COMMANDS = new Set([
  "goto", "eval", "snapshot", "find", "screenshot", "click", "hover", "check", "uncheck", "fill", "press", "select",
  "mousemove", "mousedown", "mouseup", "mousewheel", "keydown", "keyup", "resize", "go-back", "go-forward", "reload",
  "tab-list", "tab-new", "tab-select", "tab-close",
]);
let fatal = false;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  if (fatal) return;
  fatal = true;
  process.stdin.destroy();
  send({ type: "fatal", error: message });
  process.exitCode = 1;
}

function parseArgs(command, values) {
  const args = { _: [command] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const flag = value.slice(2);
    const equals = flag.indexOf("=");
    if (equals !== -1) args[flag.slice(0, equals)] = flag.slice(equals + 1);
    else if (flag === "regex") args[flag] = values[++index];
    else args[flag] = true;
  }
  return args;
}

function validRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Number.isSafeInteger(value.id) || value.id < 1) return false;
  if (typeof value.sessionName !== "string" || !SESSION_NAME.test(value.sessionName)) return false;
  if (typeof value.command !== "string" || !COMMANDS.has(value.command)) return false;
  if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((item) => typeof item !== "string" || item.length > 10_000)) return false;
  return true;
}

const cliPackagePath = fileURLToPath(import.meta.resolve("@playwright/cli/package.json"));
const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
if (cliPackage.version !== SUPPORTED_CLI_VERSION) {
  fail("Pinned Playwright CLI version is incompatible with the persistent client");
} else {
  const corePackagePath = fileURLToPath(import.meta.resolve("playwright-core/package.json"));
  const coreDirectory = dirname(corePackagePath);
  const registryModule = await import(pathToFileURL(join(coreDirectory, "lib/tools/cli-client/registry.js")).href);
  const sessionModule = await import(pathToFileURL(join(coreDirectory, "lib/tools/cli-client/session.js")).href);
  const registryExports = registryModule.default ?? registryModule;
  const sessionExports = sessionModule.default ?? sessionModule;
  const { Registry, createClientInfo } = registryExports;
  const { Session } = sessionExports;
  if (typeof Registry?.load !== "function" || typeof createClientInfo !== "function" || typeof Session !== "function") {
    fail("Pinned Playwright persistent client API is unavailable");
  } else {
    const clientInfo = createClientInfo();
    const sessions = new Map();
    let tail = Promise.resolve();

    async function sessionFor(name) {
      const cached = sessions.get(name);
      if (cached) return cached;
      const registry = await Registry.load();
      const entry = registry.entry(clientInfo, name);
      if (!entry) return undefined;
      const session = new Session(entry);
      sessions.set(name, session);
      return session;
    }

    async function execute(request) {
      const session = await sessionFor(request.sessionName);
      if (!session) {
        const error = `The browser '${request.sessionName}' is not open, please run open first`;
        send({ type: "result", id: request.id, result: { code: 1, stdout: JSON.stringify({ isError: true, error }), stderr: "", killed: false } });
        return;
      }
      try {
        const result = await session.run(clientInfo, parseArgs(request.command, request.args), { json: true });
        if (!result || typeof result.text !== "string" || Buffer.byteLength(result.text) > MAX_RESULT_BYTES) throw new Error("invalid result");
        if (result.isError && result.text.includes(`The browser '${request.sessionName}' is not open`)) sessions.delete(request.sessionName);
        send({ type: "result", id: request.id, result: { code: result.isError ? 1 : 0, stdout: result.text, stderr: "", killed: false } });
      } catch (error) {
        const missing = error instanceof Error && error.message.includes(`Browser '${request.sessionName}' is not open`);
        if (missing) sessions.delete(request.sessionName);
        const message = missing ? `The browser '${request.sessionName}' is not open, please run open first` : "Playwright persistent client command failed";
        send({ type: "result", id: request.id, result: { code: 1, stdout: JSON.stringify({ isError: true, error: message }), stderr: "", killed: false } });
      }
    }

    send({ type: "ready", version: cliPackage.version });
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      if (fatal) return;
      if (!line || Buffer.byteLength(line) > MAX_REQUEST_BYTES) return fail("Invalid Playwright helper request");
      let request;
      try { request = JSON.parse(line); } catch { return fail("Invalid Playwright helper request"); }
      if (!validRequest(request)) return fail("Invalid Playwright helper request");
      tail = tail.then(() => execute(request), () => execute(request));
    });
  }
}
