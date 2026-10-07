import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { mapLimit } from "./run-packages-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = (await readdir(join(root, "packages"), { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const action = process.argv[2];
const flags = process.argv.slice(3);
const includeWeb = action === "verify" && flags.includes("--web");
const verbose = flags.includes("--verbose");
const scripts = action === "verify" ? ["check", "test"] : [action];
if (
  !scripts.every(script => script === "check" || script === "test" || script === "install") ||
  flags.some(flag => flag !== "--verbose" && !(flag === "--web" && action === "verify")) ||
  new Set(flags).size !== flags.length
) {
  console.error("Usage: node scripts/run-packages.mjs verify [--web] [--verbose]|check|test|install [--verbose]");
  process.exit(2);
}

const concurrency = action === "install" ? 3 : Math.min(4, availableParallelism());
const run = ({ name, cwd, script }) =>
  new Promise(resolve => {
    const npmCli = process.env.npm_execpath;
    const npmArgs = script === "install"
      ? ["install"]
      : ["run", script, ...(verbose && (script === "test" || script === "verify") ? ["--", "--verbose"] : [])];
    const child = spawn(
      npmCli ? process.execPath : "npm",
      npmCli ? [npmCli, ...npmArgs] : npmArgs,
      {
        cwd,
        shell: !npmCli && process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
    });
    child.stderr.on("data", chunk => {
      output += chunk;
    });
    child.on("error", error => resolve({ name, script, code: 1, output: `${output}${error.message}\n` }));
    child.on("close", code => resolve({ name, script, code: code ?? 1, output }));
  });

for (const script of scripts) {
  const jobs = packages.map(name => ({ name, cwd: join(root, "packages", name), script }));
  // Web uses one existing slot, including its build; do not add another worker pool.
  if (includeWeb && script === "test")
    jobs.unshift({ name: "@pylon/web", cwd: join(root, "platform", "web"), script: "verify" });
  const results = await mapLimit(jobs, concurrency, run);
  for (const result of results) {
    if (script !== "install" && result.code === 0 && !verbose) continue;
    console.log(`\n=== ${result.name}: ${result.script} ===`);
    process.stdout.write(result.output);
  }
  const failed = results.find(result => result.code !== 0);
  if (failed) process.exit(failed.code);
}
