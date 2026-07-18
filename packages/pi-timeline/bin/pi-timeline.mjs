#!/usr/bin/env node
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const command = process.argv[2] || "resume";
if (command !== "resume") {
  console.error("Usage: pi-timeline resume");
  process.exit(2);
}

const sessions = (await SessionManager.list(process.cwd())).filter((session) => {
  try {
    return SessionManager.open(session.path)
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-prompt-checkpoint",
      );
  } catch {
    return false;
  }
});
if (!sessions.length) {
  console.log("No timeline sessions for current directory.");
  process.exit(0);
}

sessions.forEach((session, index) =>
  console.log(
    `${index + 1}. ${session.name || session.firstMessage} ${session.parentSessionPath ? "[fork]" : ""}`,
  ),
);
const input = createInterface({ input: stdin, output: stdout });
const answer = await input.question("Session number: ");
input.close();
const selected = sessions[Number(answer) - 1];
if (!selected) process.exit(2);

const packageEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const piCli = join(dirname(packageEntry), "cli.js");
const child = spawn(process.execPath, [piCli, "--session", selected.path], {
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(`Unable to start Pi: ${error.message}`);
  process.exit(1);
});
child.once("close", (code) => process.exit(code ?? 1));
