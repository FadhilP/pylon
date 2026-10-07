import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    verbose: { type: "boolean" },
    fast: { type: "boolean" },
    web: { type: "boolean" },
  },
});
if (values.fast && values.web) throw new Error("--fast is only supported for root verification");
const cwd = fileURLToPath(new URL(values.web ? "../platform/web/" : "../", import.meta.url));
const verboseArgs = values.verbose ? ["--verbose"] : [];

function run(command, args, shell = false) {
  const result = spawnSync(command, args, { cwd, shell, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npmRun(script, args = []) {
  const cli = process.env.npm_execpath;
  const npmArgs = ["run", script, ...args];
  run(cli ? process.execPath : "npm", cli ? [cli, ...npmArgs] : npmArgs, !cli && process.platform === "win32");
}

if (values.web) {
  npmRun("test", values.verbose ? ["--", ...verboseArgs] : []);
  npmRun("build");
} else {
  for (const script of ["test:bundle", "test:update", "test:storage", "test:install"])
    npmRun(script, values.verbose ? ["--", ...verboseArgs] : []);
  run(process.execPath, [
    fileURLToPath(new URL("./run-packages.mjs", import.meta.url)),
    ...(values.fast ? ["check"] : ["verify", "--web"]),
    ...verboseArgs,
  ]);
  if (values.fast) npmRun("build", ["--workspace", "@pylon/web"]);
}
