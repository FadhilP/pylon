import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const reporter = verbose ? "spec" : new URL("./test-errors.mjs", import.meta.url).href;
const result = spawnSync(
  process.execPath,
  [
    ...process.execArgv,
    "--test",
    `--test-reporter=${reporter}`,
    ...args.filter(arg => arg !== "--verbose"),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
