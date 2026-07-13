import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapLimit } from "./run-packages-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = [
  "pi-advisor",
  "pi-conductor-core",
  "pi-continuity",
  "pi-focus",
  "pi-guard",
  "pi-heartbeat",
  "pi-helios",
  "pi-scout",
  "pi-timeline",
  "pi-verify",
];
const action = process.argv[2];
const scripts = action === "verify" ? ["check", "test"] : [action];
if (!scripts.every((script) => script === "check" || script === "test")) {
  console.error("Usage: node scripts/run-packages.mjs verify|check|test");
  process.exit(2);
}

const concurrency = 3;
const run = (name, script) =>
  new Promise((resolve) => {
    const npmCli = process.env.npm_execpath;
    const child = spawn(
      npmCli ? process.execPath : "npm",
      npmCli ? [npmCli, "run", script] : ["run", script],
      {
        cwd: join(root, name),
        shell: !npmCli && process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ name, code: 1, output: `${output}${error.message}\n` }));
    child.on("close", (code) => resolve({ name, code: code ?? 1, output }));
  });

for (const script of scripts) {
  const results = await mapLimit(packages, concurrency, (name) => run(name, script));
  for (const result of results) {
    console.log(`\n=== ${result.name}: ${script} ===`);
    process.stdout.write(result.output);
  }
  const failed = results.find((result) => result.code !== 0);
  if (failed) process.exit(failed.code);
}
