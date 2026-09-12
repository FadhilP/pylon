import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { terminateProcessTree } from "./process.js";
import type { AndroidExec } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const SAFE_CMD_VALUE = /^[^"%!^&|<>()\r\n]+$/;

/** Package-owned, shell-free executor for fixed Android tool argv. */
export function createAndroidExec(): AndroidExec {
  return (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const timeout = options.timeout ?? 20_000;
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1024 * 1024 ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > MAX_TIMEOUT_MS
      ) {
        reject(new Error("Android command bounds are invalid"));
        return;
      }
      if (options.signal?.aborted) {
        resolve({ stdout: "", stderr: "", code: -1, killed: true });
        return;
      }
      let executable = command;
      let invocationArgs = args;
      if (process.platform === "win32" && command.toLowerCase().endsWith(".bat")) {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
        if (!systemRoot || !isAbsolute(systemRoot) || ![command, ...args].every(value => SAFE_CMD_VALUE.test(value))) {
          reject(new Error("Android batch command is unsafe"));
          return;
        }
        executable = join(systemRoot, "System32", "cmd.exe");
        invocationArgs = [
          "/d",
          "/v:off",
          "/s",
          "/c",
          `"\"${command}\" ${args.map(value => `\"${value}\"`).join(" ")}"`,
        ];
      }
      let child;
      try {
        child = spawn(executable, invocationArgs, {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let total = 0;
      let killed = false;
      let settled = false;
      let stopping = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, code = -1) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, killed });
      };
      const stop = (error?: Error) => {
        if (stopping || settled) return;
        stopping = true;
        killed = true;
        void terminateProcessTree(child, "Android command", 500, 2_000).then(
          () => finish(error, -1),
          cleanupError =>
            finish(cleanupError instanceof Error ? cleanupError : new Error("Android command cleanup failed")),
        );
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        if (stopping || settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          stop(new Error("Android command output exceeds limit"));
          return;
        }
        if (target === "stdout") stdout = Buffer.concat([stdout, chunk]);
        else stderr = Buffer.concat([stderr, chunk]);
      };
      const abort = () => stop();
      timer = setTimeout(abort, timeout);
      timer.unref?.();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", chunk => append("stdout", Buffer.from(chunk)));
      child.stderr?.on("data", chunk => append("stderr", Buffer.from(chunk)));
      child.once("error", error => {
        if (!stopping) finish(error);
      });
      child.once("close", code => {
        if (!stopping) finish(undefined, code ?? -1);
      });
    });
}
