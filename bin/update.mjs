import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const PACKAGE = "@fadhilp/pylon";
const REGISTRY_URL = "https://registry.npmjs.org/@fadhilp%2fpylon/latest";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(value) {
  const match = typeof value === "string" ? STABLE_VERSION.exec(value) : undefined;
  return match ? match.slice(1, 4).map(BigInt) : undefined;
}

export function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

async function confirmUpdate(version) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`Update Pylon to ${version}? [y/N] `)).trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

function installUpdate(version) {
  const spec = `${PACKAGE}@${version}`;
  return process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm install --global ${spec}`], { stdio: "inherit" })
    : spawnSync("npm", ["install", "--global", spec], { stdio: "inherit" });
}

export async function checkForUpdate(currentVersion, options = {}) {
  const env = options.env ?? process.env;
  if (env.PYLON_NO_UPDATE_CHECK === "1") return "continue";

  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  if (!parseVersion(currentVersion)) {
    warn("Pylon update check skipped because the installed version is invalid.");
    return "continue";
  }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const text = await response.text();
    if (text.length > 10_000) throw new Error("npm registry response was too large");
    const version = JSON.parse(text).version;
    if (!parseVersion(version)) throw new Error("npm registry returned an invalid version");
    if (!isNewerVersion(version, currentVersion)) return "continue";

    log(`Pylon ${version} is available (installed: ${currentVersion}).`);
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      log(`Run npm install --global ${PACKAGE}@${version} to update.`);
      return "continue";
    }
    if (!await (options.confirm ?? confirmUpdate)(version)) return "continue";

    let result;
    try {
      result = (options.install ?? installUpdate)(version);
    } catch {
      result = { status: null };
    }
    if (result.error || result.status !== 0) {
      warn(`Pylon update failed and may be incomplete. Run npm install --global ${PACKAGE}@${version}, then run pylon again.`);
      return "stopped";
    }
    log(`Pylon updated to ${version}. Run pylon again.`);
    return "updated";
  } catch {
    warn(`Pylon update check failed; starting ${currentVersion}.`);
    return "continue";
  }
}
