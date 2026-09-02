#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migratePylonStorage, preparePylonStorage } from "./storage.mjs";
import { checkForUpdate } from "./update.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function formatRelease(release) {
  return [
    `Pylon v${release.version} — ${release.title}`,
    release.date,
    "",
    release.summary,
    "",
    "Updated:",
    ...release.notes.map(note => `  - ${note}`),
  ].join("\n");
}

const help = `Pylon — local web coding agent workspace built on Pi.

Usage:
  pylon                         Start Pylon for the current directory
  pylon changelog [version]     Show the installed or selected release
  pylon changelog --list        List available releases
  pylon migrate                 Retry migration from ~/.pi/agent

Options:
  -h, --help                    Show this help
  --version                     Print the installed version

Quick start:
  1. cd /path/to/your/project
  2. Run pylon
  3. Open http://127.0.0.1:3141
  4. Configure providers and models in Settings, then start a session

Environment:
  PYLON_CWD             Project directory (default: current directory)
  PYLON_PORT            Web server port (default: 3141)
  PI_CODING_AGENT_DIR   Pylon data directory (default: ~/.pylon/agent)
  PYLON_NO_UPDATE_CHECK Disable update checks when set to 1`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
} else if (process.argv.includes("--version")) {
  console.log(version);
} else if (process.argv[2] === "changelog") {
  const releases = JSON.parse(readFileSync(new URL("../CHANGELOG.json", import.meta.url), "utf8"));
  const requested = process.argv[3];
  if (process.argv.length > 4) {
    console.error("Usage: pylon changelog [version|--list]");
    process.exitCode = 1;
  } else if (requested === "--list") {
    console.log(releases.map(release => `v${release.version} — ${release.date} — ${release.title}`).join("\n"));
  } else {
    const selectedVersion = (requested ?? version).replace(/^v/i, "");
    const release = releases.find(item => item.version === selectedVersion);
    if (!release) {
      console.error(
        `No changelog entry found for Pylon v${selectedVersion}. Run pylon changelog --list to see available releases.`,
      );
      process.exitCode = 1;
    } else {
      console.log(formatRelease(release));
    }
  }
} else if (process.argv[2] === "migrate") {
  try {
    const result = await migratePylonStorage();
    if (result.status === "migrated")
      console.log(`Migrated Pylon data to ${result.agentDir}. The original remains at ${result.legacyDir}.`);
    else if (result.status === "already-present")
      console.log(`Pylon data already exists at ${result.agentDir}; nothing was overwritten.`);
    else console.log(`No legacy Pylon data found at ${result.legacyDir}.`);
  } catch (error) {
    console.error(`Pylon migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  const storage = await preparePylonStorage();
  if ((await checkForUpdate(version)) === "continue") {
    const { startPylonServer } = await import("../platform/web/dist-server/server/index.js");
    const running = await startPylonServer({
      cwd: process.env.PYLON_CWD ?? process.cwd(),
      repositoryRoot: packageRoot,
      agentDir: storage.agentDir,
      development: false,
      port: process.env.PYLON_PORT ? Number(process.env.PYLON_PORT) : undefined,
    });
    const address = running.server.address();
    if (address && typeof address !== "string") console.log(`Pylon web: http://127.0.0.1:${address.port}`);

    const shutdown = () =>
      void running.close().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
