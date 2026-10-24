// A native bootstrap also works when this package is installed under node_modules,
// where Node's automatic TypeScript stripping is intentionally disabled.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

// The agent entry loads the whole runtime (~1s per worker); the index graph only imports these leaf modules.
// Falls back to the entry when the package layout differs.
async function agentLeafModules() {
  try {
    const entry = import.meta.resolve(AGENT_PACKAGE);
    const leaves = ["./core/tools/truncate.js", "./config.js"].map(path => JSON.stringify(new URL(path, entry).href));
    const url = `data:text/javascript,${encodeURIComponent(leaves.map(leaf => `export * from ${leaf};`).join("\n"))}`;
    await import(url);
    return url;
  } catch {
    return undefined;
  }
}
const agentLeaves = await agentLeafModules();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (agentLeaves && specifier === AGENT_PACKAGE) return { url: agentLeaves, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }),
    };
  },
});

const { WorkspaceIndex } = await import("./index.ts");
const pendingExec = new Map();
let nextExec = 0;
const index = new WorkspaceIndex(
  workerData.cwd,
  (command, args, options) =>
    new Promise((resolve, reject) => {
      const id = ++nextExec;
      pendingExec.set(id, { resolve, reject });
      parentPort.postMessage({ type: "exec", id, command, args, options });
    }),
  workerData.path,
  workerData.timeout,
  workerData.filesystemVerifyIntervalMs,
);
const methods = new Set([
  "refresh",
  "rebuild",
  "prune",
  "ensureFresh",
  "searchSymbols",
  "searchCode",
  "status",
  "close",
]);
const errorData = error => ({
  message: String(error?.message ?? error),
  name: error?.name,
  code: error?.code,
  stack: error?.stack,
});

parentPort.on("message", async message => {
  if (message.type === "exec-result") {
    const pending = pendingExec.get(message.id);
    if (!pending) return;
    pendingExec.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
    else pending.resolve(message.value);
    return;
  }
  if (message.type !== "call") return;
  try {
    if (!methods.has(message.method)) throw new Error("Unknown index operation");
    const value = await index[message.method](...message.args);
    // Search results carry an extra flag; encode it explicitly across the RPC boundary.
    parentPort.postMessage({ type: "result", id: message.id, value, moreAvailable: value?.moreAvailable });
  } catch (error) {
    parentPort.postMessage({ type: "result", id: message.id, error: errorData(error) });
  }
});
