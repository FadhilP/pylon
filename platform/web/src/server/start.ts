import { preparePylonStorage } from "../../../../bin/storage.mjs";

const storage = await preparePylonStorage();
const { startPylonServer } = await import("./index.ts");
const production = process.argv.includes("--production");
const running = await startPylonServer({
  development: !production,
  cwd: process.env.PYLON_CWD,
  agentDir: storage.agentDir,
  port: process.env.PYLON_PORT ? Number(process.env.PYLON_PORT) : undefined,
});
const address = running.server.address();
if (address && typeof address !== "string")
  console.log(`Pylon web: http://127.0.0.1:${address.port}`);
const shutdown = () => void running.close().finally(() => process.exit());
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
