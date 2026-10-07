import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  validGitHubAuthAction,
  validGitHubClientId,
  validGitHubRepository,
  type GitHubAccount,
  type GitHubAuthAction,
  type GitHubAuthSnapshot,
} from "../../shared/settings/github.ts";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_URL = "https://github.com/login/device/code";
const API_URL = "https://api.github.com";
const VERIFICATION_URL = "https://github.com/login/device";
const REQUEST_TIMEOUT = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface GitHubCredential {
  version: 1;
  clientId: string;
  account: GitHubAccount;
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  /** Durable uncertainty marker: a rotated refresh token must never be replayed after a crash. */
  refreshPending?: true;
}
export interface GitHubCredentialStore {
  read(): Promise<GitHubCredential | undefined>;
  write(value: GitHubCredential): Promise<void>;
  remove(): Promise<void>;
}
export class GitHubAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new GitHubAuthError(message);
}
const token = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function account(value: unknown): GitHubAccount {
  const item = value as Record<string, unknown> | null;
  if (!item || !timestamp(item.id) || typeof item.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(item.login))
    fail("GitHub returned an invalid account response.");
  return { id: item.id as number, login: item.login as string };
}
function credential(value: unknown): GitHubCredential {
  const item = value as GitHubCredential | null;
  if (
    !item ||
    item.version !== 1 ||
    !validGitHubClientId(item.clientId) ||
    !token(item.accessToken) ||
    (item.expiresAt !== undefined && !timestamp(item.expiresAt)) ||
    (item.refreshToken !== undefined && !token(item.refreshToken)) ||
    (item.refreshExpiresAt !== undefined && !timestamp(item.refreshExpiresAt)) ||
    (item.refreshPending !== undefined && item.refreshPending !== true) ||
    (item.expiresAt !== undefined && (!item.refreshToken || !item.refreshExpiresAt))
  )
    fail("Saved GitHub credentials are invalid. Disconnect and sign in again.");
  return { ...item, account: account(item.account) };
}

interface GitHubKeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

/** Dedicated OS-vault entry, isolated from model-provider and StateQL credentials. */
export function osGitHubCredentialStore(
  settingsPath: string,
  createEntry: (service: string, account: string) => Promise<GitHubKeyringEntry> = async (service, account) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  },
): GitHubCredentialStore {
  const namespace = createHash("sha256").update(resolve(settingsPath)).digest("hex");
  const entry = () => createEntry("works.earendil.pylon.github", namespace);
  return {
    async read() {
      try {
        const raw = await (await entry()).getPassword(AbortSignal.timeout(10_000));
        return raw == null ? undefined : credential(JSON.parse(raw));
      } catch {
        fail("Cannot read GitHub credentials from the OS credential vault. No plaintext fallback is used.");
      }
    },
    async write(value) {
      try {
        // Native cancellation need not stop an OS write; drain actual completion before disconnect.
        await (await entry()).setPassword(JSON.stringify(value));
      } catch {
        fail("Cannot save GitHub credentials to the OS credential vault. Sign in again after fixing vault access.");
      }
    },
    async remove() {
      try {
        const vault = await entry();
        if ((await vault.getPassword(AbortSignal.timeout(10_000))) != null && !(await vault.deleteCredential()))
          throw Error("delete failed");
      } catch {
        fail("Cannot remove saved GitHub credentials from the OS credential vault. Local disconnect is incomplete.");
      }
    },
  };
}
interface GitHubAuthOptions {
  store: GitHubCredentialStore;
  clientId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** One server-owned operation at a time. Nothing here is registered as an agent tool. */
export class GitHubAuthService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly wait: NonNullable<GitHubAuthOptions["wait"]>;
  private state: GitHubAuthSnapshot;
  private saved?: GitHubCredential;
  private initialization?: Promise<void>;
  private work?: Promise<void>;
  private controller?: AbortController;
  private owner?: string;
  private generation = 0;
  private stopping = false;
  private closed = false;

  constructor(private readonly options: GitHubAuthOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal, ref: false });
      });
    this.state = {
      revision: 0,
      phase: "disconnected",
      clientId: validGitHubClientId(options.clientId) ? options.clientId : "",
    };
  }
  private initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      try {
        this.saved = await this.options.store.read();
        if (this.saved) this.saved = credential(this.saved);
        this.reset();
      } catch {
        this.update({
          error:
            "Cannot load GitHub credentials. Check OS credential-vault access, or disconnect to remove an invalid record.",
        });
      }
    })());
  }
  private update(patch: Partial<GitHubAuthSnapshot>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
  }
  private reset(error?: string): void {
    this.state = {
      revision: this.state.revision + 1,
      phase: this.saved ? "connected" : "disconnected",
      clientId: this.saved?.clientId ?? this.state.clientId,
      account: this.saved?.account,
      expiresAt: this.saved?.expiresAt,
      error,
    };
  }
  async snapshot(owner: string): Promise<GitHubAuthSnapshot> {
    await this.initialize();
    const view = structuredClone(this.state);
    if (owner !== this.owner) delete view.device;
    return view;
  }
  async action(input: GitHubAuthAction, owner: string): Promise<GitHubAuthSnapshot> {
    if (!validGitHubAuthAction(input)) throw new GitHubAuthError("Invalid GitHub action.");
    await this.initialize();
    if (this.closed || this.stopping)
      throw new GitHubAuthError("GitHub integration is closing or cancelling an operation.", 409);
    if (input.expectedRevision !== this.state.revision)
      throw new GitHubAuthError("GitHub connection changed. Refresh before retrying.", 409);
    if (input.action === "cancel") {
      if (!this.owner || owner !== this.owner)
        throw new GitHubAuthError("Only the initiating tab can cancel this login.", 403);
      await this.stop();
    } else if (input.action === "disconnect") {
      await this.stop(true);
    } else {
      if (this.work) throw new GitHubAuthError("A GitHub operation is already in progress.", 409);
      if (input.action === "start" && this.saved)
        throw new GitHubAuthError("Disconnect the saved GitHub account before starting another login.", 409);
      if (input.action !== "start" && !this.saved) throw new GitHubAuthError("Connect a GitHub account first.");
      this.owner = input.action === "start" ? owner : undefined;
      const generation = ++this.generation;
      const controller = (this.controller = new AbortController());
      this.update({
        phase: input.action === "start" ? "starting" : "checking",
        error: undefined,
        device: undefined,
        verifiedAt: undefined,
        repository: undefined,
        ...(input.action === "start" ? { clientId: input.clientId } : {}),
      });
      const operation =
        input.action === "start"
          ? this.login(input.clientId, generation, controller.signal)
          : this.verify(input.action === "repository" ? input.repository : undefined, generation, controller.signal);
      this.work = operation
        .catch(error => {
          if (this.current(generation, controller.signal))
            this.reset(
              error instanceof GitHubAuthError
                ? error.message
                : "GitHub request failed. Check connectivity and reconnect; an uncertain token exchange must not be retried automatically.",
            );
        })
        .finally(() => {
          this.work = undefined;
          this.controller = undefined;
          this.owner = undefined;
        });
    }
    return this.snapshot(owner);
  }
  private current(generation: number, signal: AbortSignal): boolean {
    return !this.closed && generation === this.generation && !signal.aborted;
  }
  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (!this.current(generation, signal)) throw new Error("Cancelled");
  }
  private async persist(value: GitHubCredential, generation: number, signal: AbortSignal): Promise<void> {
    this.assertCurrent(generation, signal);
    // Do not abort an in-flight vault write and pretend it stopped. Disconnect drains it before deletion.
    await this.options.store.write(value);
    this.saved = value;
    this.assertCurrent(generation, signal);
  }
  private async stop(remove = false): Promise<void> {
    this.stopping = true;
    ++this.generation;
    this.controller?.abort();
    try {
      await this.work?.catch(() => undefined); // Failed authorization must not prevent explicit deletion.
      if (remove) {
        await this.options.store.remove();
        this.saved = undefined;
      }
      this.reset();
    } catch (error) {
      this.reset(
        error instanceof GitHubAuthError
          ? error.message
          : "Cannot remove saved GitHub credentials. Local disconnect is incomplete.",
      );
    } finally {
      this.stopping = false;
    }
  }
  async cancelOwner(owner: string): Promise<void> {
    if (!this.closed && !this.stopping && this.owner === owner) await this.stop();
  }
  dispose(): void {
    this.closed = true;
    ++this.generation;
    this.controller?.abort();
  }
  async close(): Promise<void> {
    this.dispose();
    await this.initialization;
    await this.work;
  }

  private async request(
    url: string,
    signal: AbortSignal,
    form?: Record<string, string>,
    accessToken?: string,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    // All callers use fixed HTTPS origins. Refuse redirects so credentials cannot cross hosts.
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Pylon-GitHub" };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    }
    const response = await this.fetcher(url, {
      method: form ? "POST" : "GET",
      headers,
      body: form && new URLSearchParams(form),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
    });
    const reader = response.body?.getReader();
    if (!reader) fail("GitHub returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) fail("GitHub response exceeded the inspection limit.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("GitHub returned an invalid response.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("GitHub returned an invalid response.");
    return { status: response.status, data: data as Record<string, unknown> };
  }
  private async api(path: string, accessToken: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { status, data } = await this.request(`${API_URL}${path}`, signal, undefined, accessToken);
    if (status === 401) fail("GitHub authorization is no longer valid. Disconnect and sign in again.");
    if (status === 403 || status === 429)
      fail("GitHub denied access or rate-limited this request. Check app permissions and try again later.");
    if (status === 404)
      fail(
        "Repository not found or inaccessible to this account and GitHub App. Check the app installation and repository selection.",
      );
    if (status !== 200) fail("GitHub could not verify access. Try reconnecting later.");
    return data;
  }
  private tokens(data: Record<string, unknown>, clientId: string, who: GitHubAccount): GitHubCredential {
    if (!token(data.access_token) || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")
      fail("GitHub returned an invalid token response. Start a new login.");
    const value: GitHubCredential = { version: 1, clientId, account: who, accessToken: data.access_token };
    if (data.expires_in !== undefined) {
      if (
        !timestamp(data.expires_in) ||
        (data.expires_in as number) > 366 * 86400 ||
        !token(data.refresh_token) ||
        !timestamp(data.refresh_token_expires_in) ||
        (data.refresh_token_expires_in as number) > 366 * 86400
      )
        fail("GitHub returned invalid token expiry information. Start a new login.");
      value.expiresAt = this.now() + (data.expires_in as number) * 1000;
      value.refreshToken = data.refresh_token;
      value.refreshExpiresAt = this.now() + (data.refresh_token_expires_in as number) * 1000;
    }
    return value;
  }
  private async login(clientId: string, generation: number, signal: AbortSignal): Promise<void> {
    if (await this.options.store.read())
      fail("Saved GitHub credentials already exist. Disconnect before starting a new login.");
    this.assertCurrent(generation, signal);
    const codes = await this.request(DEVICE_URL, signal, { client_id: clientId });
    this.assertCurrent(generation, signal);
    const data = codes.data;
    if (
      codes.status !== 200 ||
      !token(data.device_code) ||
      typeof data.user_code !== "string" ||
      !/^[A-Z0-9-]{4,32}$/.test(data.user_code) ||
      data.verification_uri !== VERIFICATION_URL ||
      !timestamp(data.expires_in) ||
      (data.expires_in as number) > 900 ||
      !timestamp(data.interval) ||
      (data.interval as number) > 900
    )
      fail("Cannot start GitHub login. Check the GitHub App client ID and enable Device flow in its settings.");
    let interval = (data.interval as number) * 1000;
    const expiresAt = this.now() + (data.expires_in as number) * 1000;
    this.update({
      phase: "authorizing",
      device: { userCode: data.user_code, verificationUri: VERIFICATION_URL, expiresAt },
    });
    while (true) {
      await this.wait(Math.min(interval, Math.max(0, expiresAt - this.now())), signal);
      this.assertCurrent(generation, signal);
      if (this.now() >= expiresAt) fail("GitHub login expired. Start a new login.");
      const result = await this.request(TOKEN_URL, signal, {
        client_id: clientId,
        device_code: data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      this.assertCurrent(generation, signal);
      if (result.status !== 200)
        fail("GitHub token exchange failed. Start a new login rather than retrying an uncertain exchange.");
      if (result.data.error === "authorization_pending") continue;
      if (result.data.error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (result.data.error === "access_denied")
        fail("GitHub authorization was denied. Start a new login if you want to retry.");
      if (result.data.error === "expired_token") fail("GitHub login expired. Start a new login.");
      if (result.data.error)
        fail("GitHub could not authorize this app. Check its device-flow configuration and start a new login.");
      if (this.now() >= expiresAt) fail("GitHub login expired. Start a new login.");
      this.update({ phase: "checking", device: undefined });
      if (!token(result.data.access_token)) fail("GitHub returned an invalid token response.");
      const who = account(await this.api("/user", result.data.access_token, signal));
      const saved = this.tokens(result.data, clientId, who);
      await this.persist(saved, generation, signal);
      this.reset();
      this.update({ verifiedAt: this.now() });
      return;
    }
  }
  private async verify(repository: string | undefined, generation: number, signal: AbortSignal): Promise<void> {
    let saved = this.saved!;
    if (saved.refreshPending)
      fail("The previous GitHub token renewal was interrupted or uncertain. Disconnect and sign in again.");
    if (saved.expiresAt !== undefined && saved.expiresAt <= this.now() + 60_000) {
      if (!saved.refreshToken || !saved.refreshExpiresAt || saved.refreshExpiresAt <= this.now())
        fail("GitHub credentials expired. Disconnect and sign in again.");
      // Mark before sending: a crash, timeout, or failed rotated-token save must not replay the old token.
      await this.persist({ ...saved, refreshPending: true }, generation, signal);
      const result = await this.request(TOKEN_URL, signal, {
        client_id: saved.clientId,
        refresh_token: saved.refreshToken,
        grant_type: "refresh_token",
      });
      this.assertCurrent(generation, signal);
      if (result.status !== 200 || result.data.error)
        fail(
          "GitHub token renewal failed or is uncertain. Disconnect and sign in again; do not retry the old refresh token.",
        );
      saved = this.tokens(result.data, saved.clientId, saved.account);
      // Save the rotated pair before further requests; the previous refresh token is no longer usable.
      await this.persist(saved, generation, signal);
    }
    const who = account(await this.api("/user", saved.accessToken, signal));
    this.assertCurrent(generation, signal);
    if (who.id !== saved.account.id) fail("GitHub account changed unexpectedly. Disconnect and sign in again.");
    if (who.login !== saved.account.login) {
      saved = { ...saved, account: who };
      await this.persist(saved, generation, signal);
    }
    let checked: GitHubAuthSnapshot["repository"];
    if (repository) {
      const data = await this.api(
        `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`,
        saved.accessToken,
        signal,
      );
      if (
        !validGitHubRepository(data.full_name) ||
        data.full_name.toLowerCase() !== repository.toLowerCase() ||
        typeof data.private !== "boolean"
      )
        fail("GitHub returned an invalid repository response.");
      checked = { fullName: data.full_name, private: data.private, checkedAt: this.now() };
    }
    this.assertCurrent(generation, signal);
    this.reset();
    this.update({ verifiedAt: this.now(), repository: checked });
  }
}
