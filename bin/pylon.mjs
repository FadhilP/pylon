#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkForUpdate } from "./update.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (process.argv.includes("--version")) {
  console.log(version);
} else if (await checkForUpdate(version) === "continue") {
  const { startPylonServer } = await import("../platform/web/dist-server/server/index.js");
  const running = await startPylonServer({
    cwd: process.env.PYLON_CWD ?? process.cwd(),
    repositoryRoot: packageRoot,
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
