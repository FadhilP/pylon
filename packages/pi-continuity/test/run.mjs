import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.PI_SPAWN_AUTONOMOUS;
delete env.PI_SPAWN_CHILD;

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), "test/*.test.ts"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
