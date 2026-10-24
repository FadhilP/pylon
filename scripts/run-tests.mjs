import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

// Git for Windows' cmd\git.exe launcher spawns mingw64\bin\git.exe per call, doubling the cost of every Git process.
if (process.platform === "win32") {
  const directories = (process.env.PATH ?? "").split(delimiter);
  const gitDirectory = directories.find(directory => directory && existsSync(join(directory, "git.exe")));
  const direct = gitDirectory && join(dirname(gitDirectory), "mingw64", "bin");
  if (basename(gitDirectory ?? "").toLowerCase() === "cmd" && existsSync(join(direct, "git.exe")))
    process.env.PATH = [direct, ...directories].join(delimiter);
}

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
