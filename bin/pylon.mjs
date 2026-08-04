#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migratePylonStorage, preparePylonStorage } from "./storage.mjs";
import { checkForUpdate } from "./update.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (process.argv.includes("--version")) {
  console.log(version);
} else if (process.argv[2] === "migrate") {
  try {
    const result = await migratePylonStorage();
    if (result.status === "migrated") console.log(`Migrated Pylon data to ${result.agentDir}. The original remains at ${result.legacyDir}.`);
    else if (result.status === "already-present") console.log(`Pylon data already exists at ${result.agentDir}; nothing was overwritten.`);
    else console.log(`No legacy Pylon data found at ${result.legacyDir}.`);
  } catch (error) {
    console.error(`Pylon migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  const storage = await preparePylonStorage();
  if (await checkForUpdate(version) === "continue") {
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

    const shutdown = () => void running.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
