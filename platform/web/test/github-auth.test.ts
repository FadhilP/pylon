import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  GitHubAuthService,
  osGitHubCredentialStore,
  type GitHubCredential,
  type GitHubCredentialStore,
} from "../src/server/settings/github-auth.ts";
import type { GitHubAuthInput } from "../src/shared/settings/github.ts";

const who = { id: 42, login: "reviewer" };
const saved: GitHubCredential = {
  version: 1,
  clientId: "Iv1.example",
  account: who,
  accessToken: "access-one",
  expiresAt: 1_001_000,
  refreshToken: "refresh-one",
  refreshExpiresAt: 20_000_000,
};
const codes = {
  device_code: "private-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};
const tokens = {
  access_token: "access-two",
  token_type: "bearer",
  expires_in: 28800,
  refresh_token: "refresh-two",
  refresh_token_expires_in: 15_552_000,
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await setImmediate();
  }
  assert.fail("Auth operation did not reach the expected state");
}
function store(initial?: GitHubCredential) {
  let value = initial && structuredClone(initial);
  const writes: GitHubCredential[] = [];
  const persistence: GitHubCredentialStore = {
    async read() {
      return value && structuredClone(value);
    },
    async write(next) {
      value = structuredClone(next);
      writes.push(structuredClone(next));
    },
    async remove() {
      value = undefined;
    },
  };
  return { persistence, writes, value: () => value };
}
function harness(initial?: GitHubCredential, tokenResponses: unknown[] = [tokens]) {
  let now = 1_000_000;
  const vault = store(initial);
  const waits: { ms: number; release: () => void }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let userStatus = 200;
  let repositoryStatus = 200;
  const service = new GitHubAuthService({
    store: vault.persistence,
    now: () => now,
    wait: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Aborted"));
        signal.addEventListener("abort", abort, { once: true });
        waits.push({
          ms,
          release: () => {
            signal.removeEventListener("abort", abort);
            now += ms;
            resolve();
          },
        });
      }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith("/login/device/code")) return reply(codes);
      if (String(url).endsWith("/login/oauth/access_token")) return reply(tokenResponses.shift());
      if (String(url).endsWith("/user"))
        return reply(userStatus === 200 ? who : { message: "access-two must not leak" }, userStatus);
      return reply({ full_name: "owner/repo", private: true }, repositoryStatus);
    },
  });
  const view = () => service.snapshot("owner");
  const act = async (action: GitHubAuthInput, owner = "owner") =>
    service.action({ ...action, expectedRevision: (await service.snapshot(owner)).revision }, owner);
  return {
    service,
    vault,
    waits,
    calls,
    view,
    act,
    setUserStatus: (status: number) => {
      userStatus = status;
    },
    setRepositoryStatus: (status: number) => {
      repositoryStatus = status;
    },
    async advance() {
      await until(() => waits.length > 0);
      waits.shift()!.release();
    },
    async settled() {
      await until(async () => ["connected", "disconnected"].includes((await view()).phase));
      return view();
    },
  };
}

test("device login honors provider polling, keeps instructions tab-owned, persists and verifies repository access after restart", async () => {
  const h = harness(undefined, [{ error: "authorization_pending" }, { error: "slow_down" }, tokens]);
  try {
    const original = await h.view();
    await h.act({ action: "start", clientId: "Iv1.example" });
    await until(async () => Boolean((await h.view()).device));
    assert.equal((await h.view()).device?.userCode, codes.user_code);
    assert.equal((await h.service.snapshot("other")).device, undefined);
    await assert.rejects(
      h.service.action({ action: "start", clientId: "Iv1.other", expectedRevision: original.revision }, "other"),
      /changed/,
    );
    await assert.rejects(h.act({ action: "cancel" }, "other"), /initiating tab/);
    assert.equal(h.calls.length, 1); // Status reads do not poll GitHub or bypass its interval.
    for (const interval of [5000, 5000, 10000]) {
      await until(() => h.waits.length > 0);
      assert.equal(h.waits[0].ms, interval);
      await h.advance();
    }
    const connected = await h.settled();
    assert.equal(connected.account?.id, who.id);
    assert.ok(connected.verifiedAt);
    assert.equal(h.vault.value()?.refreshToken, tokens.refresh_token);
    const publicState = JSON.stringify([original, connected, await h.service.snapshot("other")]);
    for (const secret of [codes.device_code, tokens.access_token, tokens.refresh_token])
      assert.ok(!publicState.includes(secret));
    await h.service.close();
    const restarted = new GitHubAuthService({
      store: h.vault.persistence,
      now: () => 1_020_000,
      fetch: async (url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${tokens.access_token}`);
        assert.equal(init?.redirect, "error");
        return String(url).endsWith("/user") ? reply(who) : reply({ full_name: "owner/repo", private: true });
      },
    });
    try {
      const loaded = await restarted.snapshot("new-tab");
      assert.equal(loaded.account?.id, who.id);
      assert.equal(loaded.verifiedAt, undefined); // A vault read alone is not proof of current authorization.
      await restarted.action(
        { action: "repository", repository: "owner/repo", expectedRevision: loaded.revision },
        "new-tab",
      );
      await until(async () => (await restarted.snapshot("new-tab")).phase === "connected");
      const verified = await restarted.snapshot("new-tab");
      assert.equal(verified.repository?.fullName, "owner/repo");
      assert.ok(verified.verifiedAt);
      await restarted.action({ action: "disconnect", expectedRevision: verified.revision }, "new-tab");
      assert.equal(h.vault.value(), undefined);
    } finally {
      await restarted.close();
    }
    for (const call of h.calls.filter(call => call.url.startsWith("https://github.com/"))) {
      assert.equal(new Headers(call.init.headers).get("authorization"), null);
      assert.equal(new URLSearchParams(call.init.body as URLSearchParams).has("client_secret"), false);
    }
  } finally {
    await h.service.close();
  }
});

test("OS-vault storage handles missing null entries, scopes records by agent directory and reports failures without secret text", async () => {
  const values = new Map<string, string>();
  const factory = async (_service: string, scope: string) => ({
    async getPassword() {
      return values.get(scope) ?? null;
    },
    async setPassword(value: string, signal?: AbortSignal) {
      assert.equal(signal, undefined); // A rejected timeout must not detach an OS mutation.
      values.set(scope, value);
    },
    async deleteCredential(signal?: AbortSignal) {
      assert.equal(signal, undefined);
      return values.delete(scope);
    },
  });
  const first = osGitHubCredentialStore("/agent-one/settings.sqlite", factory);
  const second = osGitHubCredentialStore("/agent-two/settings.sqlite", factory);
  assert.equal(await first.read(), undefined);
  await first.write(saved);
  assert.deepEqual(await first.read(), saved);
  assert.equal(await second.read(), undefined);
  await second.remove();
  assert.deepEqual(await first.read(), saved);
  await first.remove();
  assert.equal(await first.read(), undefined);
  const unavailable = osGitHubCredentialStore("/unavailable", async () => {
    throw Error("access-one sensitive provider failure");
  });
  for (const operation of [() => unavailable.read(), () => unavailable.write(saved), () => unavailable.remove()]) {
    await assert.rejects(
      operation(),
      error => error instanceof Error && /vault/.test(error.message) && !error.message.includes("access-one"),
    );
  }
});

test("denied and expired device authorizations do not persist tokens; cancellation and shutdown stop polling", async () => {
  for (const reason of ["access_denied", "expired_token"]) {
    const h = harness(undefined, [{ error: reason }]);
    try {
      await h.act({ action: "start", clientId: "Iv1.example" });
      await h.advance();
      const state = await h.settled();
      assert.match(state.error!, reason === "access_denied" ? /denied/ : /expired/);
      assert.equal(h.vault.value(), undefined);
    } finally {
      await h.service.close();
    }
  }
  for (const stop of ["cancel", "close"] as const) {
    const h = harness();
    await h.act({ action: "start", clientId: "Iv1.example" });
    await until(() => h.waits.length === 1);
    if (stop === "cancel") await h.act({ action: "cancel" });
    else await h.service.close();
    h.waits[0].release();
    await setImmediate();
    assert.equal(h.calls.length, 1);
    assert.equal(h.vault.value(), undefined);
    await h.service.close();
  }
});

test("disconnect drains an in-flight vault write before deleting, so a late login cannot revive credentials", async () => {
  const h = harness();
  let entered = false;
  let release!: () => void;
  const write = h.vault.persistence.write;
  h.vault.persistence.write = async value => {
    entered = true;
    await new Promise<void>(resolve => {
      release = resolve;
    });
    await write(value);
  };
  try {
    await h.act({ action: "start", clientId: "Iv1.example" });
    await h.advance();
    await until(() => entered);
    let disconnected = false;
    const stop = h.act({ action: "disconnect" }).then(() => {
      disconnected = true;
    });
    await setImmediate();
    assert.equal(disconnected, false);
    release();
    await stop;
    assert.equal(h.vault.value(), undefined);
    assert.equal((await h.view()).phase, "disconnected");
  } finally {
    release?.();
    await h.service.close();
  }
});

test("expiring device-flow credentials rotate without a client secret and persist the pair before verification", async () => {
  const h = harness(saved);
  try {
    await h.act({ action: "reconnect" });
    const state = await h.settled();
    assert.ok(state.verifiedAt);
    assert.equal(h.vault.writes[0].refreshPending, true);
    assert.equal(h.vault.writes[1].refreshToken, "refresh-two");
    assert.equal(h.vault.writes[1].refreshPending, undefined);
    const form = new URLSearchParams(h.calls[0].init.body as URLSearchParams);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh-one");
    assert.equal(form.has("client_secret"), false);
    assert.equal(new Headers(h.calls[1].init.headers).get("authorization"), "Bearer access-two");
  } finally {
    await h.service.close();
  }
});

test("uncertain refresh exchange and failed rotation save cannot replay the old refresh token, including after restart", async () => {
  for (const failure of ["exchange", "save"] as const) {
    const h = harness(saved, failure === "exchange" ? [{ error: "bad_refresh_token" }] : [tokens]);
    const write = h.vault.persistence.write;
    if (failure === "save")
      h.vault.persistence.write = async value => {
        if (!value.refreshPending) throw Error("refresh-two must not leak");
        await write(value);
      };
    try {
      await h.act({ action: "reconnect" });
      const state = await h.settled();
      assert.ok(state.error);
      assert.ok(!state.error!.includes("refresh-two"));
      assert.equal(h.vault.value()?.refreshPending, true);
      const calls = h.calls.length;
      await h.act({ action: "reconnect" });
      await h.settled();
      assert.equal(h.calls.length, calls);
      await h.service.close();
      const restarted = new GitHubAuthService({
        store: h.vault.persistence,
        fetch: async () => {
          assert.fail("Must not replay an uncertain refresh token");
        },
      });
      try {
        await restarted.action(
          { action: "reconnect", expectedRevision: (await restarted.snapshot("tab")).revision },
          "tab",
        );
        await until(async () => Boolean((await restarted.snapshot("tab")).error));
        await restarted.action(
          { action: "disconnect", expectedRevision: (await restarted.snapshot("tab")).revision },
          "tab",
        );
        assert.equal(h.vault.value(), undefined);
      } finally {
        await restarted.close();
      }
    } finally {
      await h.service.close();
    }
  }
});

test("inaccessible repositories, revoked authorization, unsafe paths and oversized responses fail without provider text", async () => {
  const h = harness({ ...saved, expiresAt: 10_000_000 });
  try {
    await assert.rejects(h.act({ action: "repository", repository: "../repo" }), /Invalid/);
    assert.equal(h.calls.length, 0);
    h.setRepositoryStatus(404);
    await h.act({ action: "repository", repository: "owner/repo" });
    assert.match((await h.settled()).error!, /not found or inaccessible/);
    h.setUserStatus(401);
    await h.act({ action: "reconnect" });
    const state = await h.settled();
    assert.match(state.error!, /no longer valid/);
    assert.equal(state.verifiedAt, undefined);
    assert.ok(!JSON.stringify(state).includes("access-two"));
  } finally {
    await h.service.close();
  }
  const service = new GitHubAuthService({
    store: store().persistence,
    fetch: async () => reply({ body: "x".repeat(70_000) }),
  });
  try {
    await service.action(
      { action: "start", clientId: "Iv1.example", expectedRevision: (await service.snapshot("tab")).revision },
      "tab",
    );
    await until(async () => Boolean((await service.snapshot("tab")).error));
    assert.match((await service.snapshot("tab")).error!, /inspection limit/);
  } finally {
    await service.close();
  }
});

test("disconnect invalidates a late refresh response and drains it without restoring credentials", async () => {
  const vault = store(saved);
  let requested = false;
  let release!: () => void;
  const service = new GitHubAuthService({
    store: vault.persistence,
    now: () => 1_000_000,
    fetch: async () => {
      requested = true;
      await new Promise<void>(resolve => {
        release = resolve;
      }); // Simulate a transport ignoring abort.
      return reply(tokens);
    },
  });
  try {
    await service.action({ action: "reconnect", expectedRevision: (await service.snapshot("tab")).revision }, "tab");
    await until(() => requested);
    const stop = service.action(
      { action: "disconnect", expectedRevision: (await service.snapshot("tab")).revision },
      "tab",
    );
    await setImmediate();
    release();
    await stop;
    assert.equal(vault.value(), undefined);
    assert.equal(vault.writes.length, 1); // Only the pre-exchange uncertainty marker, never the late token pair.
    assert.equal((await service.snapshot("tab")).phase, "disconnected");
  } finally {
    release?.();
    await service.close();
  }
});

test("vault preflight failure prevents authorization and a failed delete does not claim disconnection", async () => {
  const unavailable = new GitHubAuthService({
    store: {
      async read() {
        throw Error("sensitive-vault-detail");
      },
      async write() {
        assert.fail();
      },
      async remove() {
        throw Error("sensitive-vault-detail");
      },
    },
    fetch: async () => {
      assert.fail("Cannot authorize without secure credential storage");
    },
  });
  try {
    await unavailable.action(
      { action: "start", clientId: "Iv1.example", expectedRevision: (await unavailable.snapshot("tab")).revision },
      "tab",
    );
    await until(async () => (await unavailable.snapshot("tab")).phase === "disconnected");
    assert.ok(!(await unavailable.snapshot("tab")).error?.includes("sensitive-vault-detail"));
  } finally {
    await unavailable.close();
  }
  const vault = store(saved);
  vault.persistence.remove = async () => {
    throw Error("access-one");
  };
  const service = new GitHubAuthService({ store: vault.persistence });
  try {
    const state = await service.action(
      { action: "disconnect", expectedRevision: (await service.snapshot("tab")).revision },
      "tab",
    );
    assert.equal(state.account?.id, saved.account.id);
    assert.match(state.error!, /disconnect is incomplete/);
    assert.ok(!state.error!.includes(saved.accessToken));
    assert.deepEqual(vault.value(), saved);
  } finally {
    await service.close();
  }
});

test("local device expiry stops before token exchange and unexpected verification destinations are never exposed", async () => {
  for (const unsafe of [false, true]) {
    let now = 1_000_000;
    let calls = 0;
    const service = new GitHubAuthService({
      store: store().persistence,
      now: () => now,
      wait: async ms => {
        now += ms;
      },
      fetch: async () => {
        calls++;
        assert.equal(calls, 1);
        return reply({
          ...codes,
          expires_in: 1,
          ...(unsafe ? { verification_uri: "https://other.example/device" } : {}),
        });
      },
    });
    try {
      await service.action(
        { action: "start", clientId: "Iv1.example", expectedRevision: (await service.snapshot("tab")).revision },
        "tab",
      );
      await until(async () => (await service.snapshot("tab")).phase === "disconnected");
      const state = await service.snapshot("tab");
      assert.match(state.error!, unsafe ? /Cannot start/ : /expired/);
      assert.equal(state.device, undefined);
      assert.ok(!JSON.stringify(state).includes("other.example"));
      assert.equal(calls, 1);
    } finally {
      await service.close();
    }
  }
});

test("refresh does not contact GitHub unless its uncertainty marker is durably saved", async () => {
  const h = harness(saved);
  h.vault.persistence.write = async () => {
    throw Error("OS vault write failed");
  };
  try {
    await h.act({ action: "reconnect" });
    const state = await h.settled();
    assert.ok(state.error);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.vault.value(), saved);
    await h.act({ action: "disconnect" });
    assert.equal(h.vault.value(), undefined);
  } finally {
    await h.service.close();
  }
});
