import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const PACKAGE = "@fadhilp/pylon";
const REGISTRY_URL = "https://registry.npmjs.org/@fadhilp%2fpylon/latest";
const CACHE_MS = 24 * 60 * 60 * 1_000;
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
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm install --global ${spec}`], {
        stdio: "inherit",
      })
    : spawnSync("npm", ["install", "--global", spec], { stdio: "inherit" });
}

async function cachedVersion(path, currentVersion, now) {
  if (!path) return;
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length > 10_000) return;
    const value = JSON.parse(raw);
    if (
      value.currentVersion !== currentVersion ||
      !parseVersion(value.latestVersion) ||
      !Number.isSafeInteger(value.checkedAt) ||
      value.checkedAt > now ||
      now - value.checkedAt >= CACHE_MS
    )
      return;
    return value.latestVersion;
  } catch {
    return;
  }
}

async function cacheVersion(path, currentVersion, latestVersion, checkedAt) {
  if (!path) return;
  const temporary = `${path}.${process.pid}.${checkedAt}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ currentVersion, latestVersion, checkedAt })}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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
    const now = options.now?.() ?? Date.now();
    const cacheFile =
      options.cacheFile === null
        ? undefined
        : (options.cacheFile ?? (options.fetch ? undefined : join(homedir(), ".pylon", "update-check.json")));
    let version = await cachedVersion(cacheFile, currentVersion, now);
    if (!version) {
      const response = await (options.fetch ?? globalThis.fetch)(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
      const text = await response.text();
      if (text.length > 10_000) throw new Error("npm registry response was too large");
      version = JSON.parse(text).version;
      if (!parseVersion(version)) throw new Error("npm registry returned an invalid version");
      await cacheVersion(cacheFile, currentVersion, version, now);
    }
    if (!isNewerVersion(version, currentVersion)) return "continue";

    log(`Pylon ${version} is available (installed: ${currentVersion}).`);
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      log(`Run npm install --global ${PACKAGE}@${version} to update.`);
      return "continue";
    }
    if (!(await (options.confirm ?? confirmUpdate)(version))) return "continue";

    let result;
    try {
      result = (options.install ?? installUpdate)(version);
    } catch {
      result = { status: null };
    }
    if (result.error || result.status !== 0) {
      warn(
        `Pylon update failed and may be incomplete. Run npm install --global ${PACKAGE}@${version}, then run pylon again.`,
      );
      return "stopped";
    }
    log(`Pylon updated to ${version}. Run pylon again.`);
    return "updated";
  } catch {
    warn(`Pylon update check failed; starting ${currentVersion}.`);
    return "continue";
  }
}
