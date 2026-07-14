import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WEB_SCOUT_GRANT_ENV = "PI_HELIOS_WEB_SCOUT_GRANT";
const GRANT_ROOT = join(tmpdir(), "pi-helios-web-grants");

type GrantFile = {
  version: 1;
  token: string;
  expiresAt: number;
  maxPages: number;
  maxActions: number;
  headed: boolean;
};

export type WebScoutGrant = Omit<GrantFile, "version" | "token" | "expiresAt">;

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueWebScoutGrant(options: WebScoutGrant): Promise<{ value: string; revoke: () => Promise<void> }> {
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 12) throw new Error("Web Scout maxPages must be 1 to 12");
  if (!Number.isInteger(options.maxActions) || options.maxActions < options.maxPages || options.maxActions > 80) throw new Error("Web Scout maxActions is invalid");
  await mkdir(GRANT_ROOT, { recursive: true, mode: 0o700 });
  await chmod(GRANT_ROOT, 0o700).catch(() => {});
  const directory = await mkdtemp(join(GRANT_ROOT, "grant-"));
  await chmod(directory, 0o700).catch(() => {});
  const path = join(directory, "grant.json");
  const token = randomBytes(32).toString("base64url");
  const grant: GrantFile = { version: 1, token, expiresAt: Date.now() + 60_000, ...options };
  await writeFile(path, `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  const revoke = async () => {
    await rm(path, { force: true }).catch(() => {});
    await rmdir(directory).catch(() => {});
  };
  return {
    value: Buffer.from(JSON.stringify({ path, token }), "utf8").toString("base64url"),
    revoke,
  };
}

export async function consumeWebScoutGrant(encoded = process.env[WEB_SCOUT_GRANT_ENV]): Promise<WebScoutGrant> {
  if (!encoded || encoded.length > 4096) throw new Error("Web Scout browser grant is missing");
  let envelope: { path?: unknown; token?: unknown };
  try { envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("Web Scout browser grant is invalid"); }
  if (typeof envelope.path !== "string" || typeof envelope.token !== "string") throw new Error("Web Scout browser grant is invalid");
  const path = resolve(envelope.path);
  const directory = dirname(path);
  const pathWithinRoot = relative(GRANT_ROOT, path);
  if (
    !isAbsolute(path) || basename(path) !== "grant.json" ||
    pathWithinRoot.startsWith("..") || isAbsolute(pathWithinRoot) ||
    !/^grant-[^\\/]+[\\/]grant\.json$/.test(pathWithinRoot)
  ) throw new Error("Web Scout browser grant path is invalid");
  try {
    const [rootPath, directoryPath, fileInfo] = await Promise.all([realpath(GRANT_ROOT), realpath(directory), lstat(path)]);
    if (relative(rootPath, directoryPath).startsWith("..") || fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error();
  } catch { throw new Error("Web Scout browser grant path is invalid"); }
  let grant: GrantFile;
  try { grant = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Web Scout browser grant is unavailable"); }
  if (
    grant?.version !== 1 ||
    typeof grant.token !== "string" ||
    !equal(grant.token, envelope.token) ||
    !Number.isFinite(grant.expiresAt) || grant.expiresAt < Date.now() ||
    !Number.isInteger(grant.maxPages) || grant.maxPages < 1 || grant.maxPages > 12 ||
    !Number.isInteger(grant.maxActions) || grant.maxActions < grant.maxPages || grant.maxActions > 80 ||
    typeof grant.headed !== "boolean"
  ) throw new Error("Web Scout browser grant is invalid or expired");
  await rm(path, { force: true });
  await rmdir(directory).catch(() => {});
  delete process.env[WEB_SCOUT_GRANT_ENV];
  return { maxPages: grant.maxPages, maxActions: grant.maxActions, headed: grant.headed };
}
