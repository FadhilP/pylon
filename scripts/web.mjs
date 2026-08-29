import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = resolve(root, "platform/web/dist/.pylon-build-state");
const output = resolve(root, "platform/web/dist/index.html");

function currentState() {
  try {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash
        .update(file)
        .update("\0")
        .update(readFileSync(resolve(root, file)))
        .update("\0");
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function run(script) {
  const [command, args] =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm run ${script} --workspace @pylon/web`]]
      : ["npm", ["run", script, "--workspace", "@pylon/web"]];
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const state = currentState();
const unchanged =
  state !== undefined && existsSync(output) && existsSync(marker) && readFileSync(marker, "utf8").trim() === state;

if (unchanged) {
  console.log("Web build is unchanged; starting existing build.");
} else {
  run("build");
  const builtState = currentState();
  if (builtState !== undefined && builtState === state) writeFileSync(marker, `${builtState}\n`);
}

run("start");
