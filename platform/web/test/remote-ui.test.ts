import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteUiBridge,
  type StateQLCredentialHost,
  type StateQLCredentialRequest,
  type UiRequest,
} from "../src/server/pi/remote-ui-context.ts";

function stateqlRequest(
  access: "read" | "write" = "read",
  overrides: Partial<StateQLCredentialRequest> = {},
): StateQLCredentialRequest {
  return {
    reference: "APP_DATABASE_URL",
    actorId: "session-1",
    session: { id: "stateql-1", name: "workspace" },
    operation: access === "read" ? "query" : "exec",
    access,
    connection: { id: "connection-1", name: "app", driver: "postgres", database: "app", readOnly: false },
    ...overrides,
  };
}

function stateqlHost(bridge: RemoteUiBridge, generation = 3): StateQLCredentialHost {
  return bridge.context("session-1", generation) as ReturnType<RemoteUiBridge["context"]> & StateQLCredentialHost;
}

const DATABASE_URL = "postgres://private:sentinel@localhost/app";

test("remote UI correlates every RPC dialog and validates responses", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request), 1_000);
  const ui = bridge.context("session-1", 3);

  const selected = ui.select("Choose", ["A", "B"]);
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "select", value: "B" });
  assert.equal(await selected, "B");

  const confirmed = ui.confirm("Confirm", "Proceed?");
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "confirm", confirmed: true });
  assert.equal(await confirmed, true);

  const input = ui.input("Name");
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "input", value: "Pylon" });
  assert.equal(await input, "Pylon");

  const edited = (
    ui.editor as (title: string, prefill?: string, options?: { timeout?: number }) => Promise<string | undefined>
  )("Edit", "before", { timeout: 0 });
  const editorRequest = requests.at(-1)!;
  assert.equal(editorRequest.timeoutSeconds, undefined);
  assert.equal(editorRequest.expiresAt, undefined);
  bridge.answer({ requestId: editorRequest.requestId, sessionGeneration: 3, method: "editor", value: "after" });
  assert.equal(await edited, "after");

  assert.throws(
    () => bridge.answer({ requestId: "missing", sessionGeneration: 3, method: "confirm", confirmed: true }),
    /unknown or expired/,
  );
});

test("provider auth prompts mark secrets without publishing their value", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  bridge.context("session-1", 3);
  const controller = new AbortController();
  const pending = bridge.authPrompt("session-1", 3, { type: "secret", message: "API key" }, controller.signal);
  const request = requests.at(-1)!;
  assert.equal(request.payload.inputType, "password");
  assert.equal(request.payload.context, "provider-auth");
  assert.equal(JSON.stringify(request.payload).includes("sk-test"), false);
  bridge.answer({ requestId: request.requestId, sessionGeneration: 3, method: "input", value: "sk-test" });
  assert.equal(await pending, "sk-test");
  assert.equal(JSON.stringify(request.payload).includes("sk-test"), false);
});

test("StateQL credentials use masked metadata-only prompts, reuse reads, and require write escalation", async () => {
  const sentinel = DATABASE_URL;
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(structuredClone(request)));
  const host = stateqlHost(bridge);

  const first = host.requestStateQLCredential(stateqlRequest("read"));
  const prompt = requests.at(-1)!;
  assert.equal(prompt.payload.context, "stateql-credential");
  assert.equal(prompt.payload.inputType, "password");
  assert.equal(prompt.payload.reference, "APP_DATABASE_URL");
  assert.equal(prompt.payload.access, "read");
  assert.match(String(prompt.payload.title), /database connection source/i);
  assert.match(String(prompt.payload.message), /complete PostgreSQL connection URL/);
  assert.equal(JSON.stringify(prompt).includes(sentinel), false);
  bridge.answer({ requestId: prompt.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await first, sentinel);

  assert.equal(await host.requestStateQLCredential(stateqlRequest("read")), sentinel);
  assert.equal(requests.length, 1);

  const escalation = host.requestStateQLCredential(stateqlRequest("write"));
  const writePrompt = requests.at(-1)!;
  assert.notEqual(writePrompt.requestId, prompt.requestId);
  assert.equal(writePrompt.payload.access, "write");
  bridge.answer({ requestId: writePrompt.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await escalation, sentinel);
  assert.equal(await host.requestStateQLCredential(stateqlRequest("read")), sentinel);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify({ requests, snapshot: bridge.snapshot() }).includes(sentinel), false);
});

test("StateQL password broker reuses endpoint consent, separates kinds and targets, and invalidates", async () => {
  const password = "p%@:/# Ü";
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(structuredClone(request)));
  const host = stateqlHost(bridge);
  const reference = (character: string) => `PYLON_STATEQL_BROKERED_${character.repeat(48)}`;
  const connectRequest = (character: string) =>
    stateqlRequest("read", {
      reference: reference(character),
      operation: "connect",
      connection: undefined,
      requestedReadOnly: true,
    });
  const target = {
    driver: "postgres" as const,
    username: "postgres",
    hostname: "db.example.com",
    port: 5432,
    database: "app",
  };
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 24 * 60 * 60_000 + 1]) {
    await assert.rejects(
      host.requestStateQLPassword(connectRequest("Z"), target, { timeoutMs }),
      /password dialog timeout is invalid/,
    );
  }
  assert.equal(requests.length, 0);

  const first = host.requestStateQLPassword(connectRequest("A"), target, { timeoutMs: 90_000 });
  const joined = host.requestStateQLPassword(connectRequest("B"), target);
  const prompt = requests[0];
  assert.equal(prompt.timeoutSeconds, 90);
  assert.equal(prompt.payload.title, "Enter database password");
  assert.equal(prompt.payload.inputType, "password");
  assert.match(String(prompt.payload.message), /connect to postgres@db\.example\.com:5432\/app with read-only access/);
  assert.match(String(prompt.payload.message), /selected model provider/);
  assert.equal(JSON.stringify(prompt).includes(password), false);
  bridge.answer({ requestId: prompt.requestId, sessionGeneration: 3, method: "input", value: password });
  assert.deepEqual(await Promise.all([first, joined]), [password, password]);

  const queryRequest = stateqlRequest("read", { reference: reference("C") });
  assert.equal(await host.requestStateQLPassword(queryRequest, target), password);
  assert.equal(requests.length, 1);

  const source = host.requestStateQLCredential(queryRequest);
  assert.equal(requests.length, 2);
  bridge.answer({ requestId: requests[1].requestId, sessionGeneration: 3, method: "input", value: DATABASE_URL });
  assert.equal(await source, DATABASE_URL);

  const otherTarget = { ...target, hostname: "other.example.com" };
  const other = host.requestStateQLPassword(connectRequest("D"), otherTarget, { timeoutMs: 0 });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].timeoutSeconds, undefined);
  bridge.answer({ requestId: requests[2].requestId, sessionGeneration: 3, method: "input", value: "other password" });
  assert.equal(await other, "other password");

  host.invalidateStateQLPassword(queryRequest, target);
  const retry = host.requestStateQLPassword(connectRequest("E"), target);
  assert.equal(requests.length, 4);
  bridge.answer({ requestId: requests[3].requestId, sessionGeneration: 3, method: "input", value: password });
  assert.equal(await retry, password);

  const writeRequest = stateqlRequest("write", { reference: reference("F") });
  const escalation = host.requestStateQLPassword(writeRequest, target);
  assert.equal(requests.length, 5);
  assert.match(String(requests[4].payload.message), /read-write access/);
  bridge.answer({ requestId: requests[4].requestId, sessionGeneration: 3, method: "input", value: password });
  assert.equal(await escalation, password);

  const defaultTarget = { ...target, hostname: "default.example.com" };
  const defaultTimeout = host.requestStateQLPassword(connectRequest("G"), defaultTarget);
  assert.equal(requests.length, 6);
  assert.equal(requests[5].timeoutSeconds, 60);
  bridge.answer({ requestId: requests[5].requestId, sessionGeneration: 3, method: "input", value: password });
  assert.equal(await defaultTimeout, password);
  assert.equal(JSON.stringify({ requests, snapshot: bridge.snapshot() }).includes(password), false);
});

test("StateQL rejects password-only connection responses without retaining them", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  const host = stateqlHost(bridge);
  const connectRequest = stateqlRequest("read", {
    operation: "connect",
    connection: undefined,
    profile: { name: "app" },
    requestedReadOnly: true,
  });
  const pending = host.requestStateQLCredential(connectRequest);
  const prompt = requests.at(-1)!;
  bridge.answer({ requestId: prompt.requestId, sessionGeneration: 3, method: "input", value: "password-only" });
  await assert.rejects(pending, /complete PostgreSQL\/MySQL URL or explicit sqlite:<path> source/);
  assert.equal(JSON.stringify({ requests, snapshot: bridge.snapshot() }).includes("password-only"), false);

  const retry = host.requestStateQLCredential(connectRequest);
  assert.equal(requests.length, 2);
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "input", value: DATABASE_URL });
  assert.equal(await retry, DATABASE_URL);
});

test("StateQL accepts explicit SQLite sources and rejects bare paths or wrong stored drivers", async () => {
  const sqliteRequest = stateqlRequest("read", {
    connection: { id: "connection-1", name: "app", driver: "sqlite", database: "app.sqlite", readOnly: true },
  });
  const source = "sqlite:./private.sqlite";
  const acceptedRequests: UiRequest[] = [];
  const acceptedBridge = new RemoteUiBridge(request => acceptedRequests.push(request));
  const accepted = stateqlHost(acceptedBridge).requestStateQLCredential(sqliteRequest);
  assert.match(String(acceptedRequests[0].payload.message), /explicit sqlite:<path> source/);
  acceptedBridge.answer({
    requestId: acceptedRequests[0].requestId,
    sessionGeneration: 3,
    method: "input",
    value: source,
  });
  assert.equal(await accepted, source);
  assert.equal(JSON.stringify({ acceptedRequests, snapshot: acceptedBridge.snapshot() }).includes(source), false);

  const invalidRequests: UiRequest[] = [];
  const invalidBridge = new RemoteUiBridge(request => invalidRequests.push(request));
  const invalidHost = stateqlHost(invalidBridge);
  const bare = invalidHost.requestStateQLCredential(sqliteRequest);
  invalidBridge.answer({
    requestId: invalidRequests[0].requestId,
    sessionGeneration: 3,
    method: "input",
    value: "./private.sqlite",
  });
  await assert.rejects(bare, /explicit sqlite:<path> source/);

  const wrongValue = "mysql://private:sentinel@localhost/app";
  const wrongDriver = invalidHost.requestStateQLCredential(stateqlRequest());
  invalidBridge.answer({
    requestId: invalidRequests[1].requestId,
    sessionGeneration: 3,
    method: "input",
    value: wrongValue,
  });
  await assert.rejects(wrongDriver, /complete PostgreSQL connection URL/);
  assert.equal(JSON.stringify({ invalidRequests, snapshot: invalidBridge.snapshot() }).includes(wrongValue), false);
});

test("StateQL rejects malformed or unsupported connection sources without retention", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  const host = stateqlHost(bridge);
  const connectRequest = stateqlRequest("read", { operation: "connect", connection: undefined });
  const invalidSources = [
    "sqlite:",
    "sqlite: ",
    "sqlite::memory:",
    "sqlite://host/app",
    "postgres:database",
    "postgres://",
    "https://localhost/app",
  ];
  for (const [index, value] of invalidSources.entries()) {
    const pending = host.requestStateQLCredential(connectRequest);
    bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "input", value });
    await assert.rejects(pending, /expected source format/);
    assert.equal(requests.length, index + 1);
  }
  const visible = JSON.stringify({ requests, snapshot: bridge.snapshot() });
  assert.equal(visible.includes("postgres:database"), false);
  assert.equal(visible.includes("https://localhost/app"), false);
});

test("StateQL credential prompts single-flight, cancel without binding, and retry cleanly", async () => {
  const sentinel = DATABASE_URL;
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  const host = stateqlHost(bridge);

  const first = host.requestStateQLCredential(stateqlRequest());
  const second = host.requestStateQLCredential(stateqlRequest());
  assert.equal(requests.length, 1);
  bridge.answer({ requestId: requests[0].requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.deepEqual(await Promise.all([first, second]), [sentinel, sentinel]);

  bridge.cancelAll();
  const joinedController = new AbortController();
  const joinedCancelled = host.requestStateQLCredential(stateqlRequest("read", { signal: joinedController.signal }));
  const joinedActive = host.requestStateQLCredential(stateqlRequest());
  const joinedPrompt = requests.at(-1)!;
  joinedController.abort();
  assert.equal(await joinedCancelled, undefined);
  bridge.answer({ requestId: joinedPrompt.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await joinedActive, sentinel);

  bridge.cancelAll();
  const controller = new AbortController();
  const cancelled = host.requestStateQLCredential(stateqlRequest("read", { signal: controller.signal }));
  const cancelledPrompt = requests.at(-1)!;
  controller.abort();
  assert.equal(await cancelled, undefined);
  assert.throws(
    () =>
      bridge.answer({ requestId: cancelledPrompt.requestId, sessionGeneration: 3, method: "input", value: sentinel }),
    /unknown or expired/,
  );

  const retry = host.requestStateQLCredential(stateqlRequest());
  const retryPrompt = requests.at(-1)!;
  assert.notEqual(retryPrompt.requestId, cancelledPrompt.requestId);
  bridge.answer({ requestId: retryPrompt.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await retry, sentinel);
});

test("StateQL credential bindings reject identity changes, expire, and clear on generation replacement", async () => {
  let now = 1_000;
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(
    request => requests.push(request),
    1_000,
    () => {},
    100,
    () => now,
  );
  const host = stateqlHost(bridge);
  const sentinel = DATABASE_URL;
  await assert.rejects(
    host.requestStateQLCredential(stateqlRequest("read", { actorId: "other-session" })),
    /actor does not match/,
  );
  await assert.rejects(
    host.requestStateQLCredential(stateqlRequest("read", { reference: "invalid-reference" })),
    /reference is invalid/,
  );
  const first = host.requestStateQLCredential(stateqlRequest());
  now = 5_000;
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await first, sentinel);
  now = 5_099;
  assert.equal(await host.requestStateQLCredential(stateqlRequest()), sentinel);

  await assert.rejects(
    host.requestStateQLCredential(
      stateqlRequest("read", {
        connection: { id: "connection-2", name: "other", driver: "postgres", database: "other", readOnly: false },
      }),
    ),
    /identity does not match/,
  );
  assert.equal(requests.length, 1);

  now = 5_101;
  const expired = host.requestStateQLCredential(stateqlRequest());
  assert.equal(requests.length, 2);
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "input", value: sentinel });
  assert.equal(await expired, sentinel);

  bridge.cancelAll();
  const stale = host.requestStateQLCredential(stateqlRequest());
  const stalePrompt = requests.at(-1)!;
  bridge.context("session-2", 4);
  assert.equal(await stale, undefined);
  assert.throws(
    () => bridge.answer({ requestId: stalePrompt.requestId, sessionGeneration: 3, method: "input", value: sentinel }),
    /unknown or expired/,
  );
  assert.equal(await host.requestStateQLCredential(stateqlRequest()), undefined);
  const replacement = bridge.context("session-2", 4) as ReturnType<RemoteUiBridge["context"]> & StateQLCredentialHost;
  const replacementRequest = stateqlRequest("read", { actorId: "session-2" });
  const rebound = replacement.requestStateQLCredential(replacementRequest);
  const reboundPrompt = requests.at(-1)!;
  bridge.answer({ requestId: reboundPrompt.requestId, sessionGeneration: 4, method: "input", value: sentinel });
  assert.equal(await rebound, sentinel);
  const promptCount = requests.length;
  bridge.dispose();
  assert.equal(await replacement.requestStateQLCredential(replacementRequest), undefined);
  assert.equal(requests.length, promptCount);
});

test("StateQL credential prompt publication failures clear single-flight state for retry", async () => {
  const requests: UiRequest[] = [];
  let fail = true;
  const bridge = new RemoteUiBridge(request => {
    if (fail) throw new Error("publish failed");
    requests.push(request);
  });
  const host = stateqlHost(bridge);
  await assert.rejects(host.requestStateQLCredential(stateqlRequest()), /publish failed/);
  assert.equal(bridge.hasPendingDialog, false);

  fail = false;
  const empty = host.requestStateQLCredential(stateqlRequest());
  assert.equal(requests.length, 1);
  bridge.answer({ requestId: requests[0].requestId, sessionGeneration: 3, method: "input", value: "" });
  assert.equal(await empty, undefined);

  const retry = host.requestStateQLCredential(stateqlRequest());
  assert.equal(requests.length, 2);
  bridge.answer({ requestId: requests[1].requestId, sessionGeneration: 3, method: "input", value: DATABASE_URL });
  assert.equal(await retry, DATABASE_URL);
});

test("remote UI fails closed on abort, timeout, and generation cancellation", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request), 10);
  const ui = bridge.context("session-1", 4);

  const controller = new AbortController();
  const confirmation = ui.confirm("Confirm", "Proceed?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirmation, false);

  const expired = ui.select("Choose", ["A"], { timeout: 1 });
  const expiredRequest = requests.at(-1)!;
  assert.equal(await expired, undefined);
  assert.throws(
    () => bridge.answer({ requestId: expiredRequest.requestId, sessionGeneration: 4, method: "select", value: "A" }),
    /unknown or expired/,
  );

  const editor = ui.editor("Edit");
  bridge.cancelGeneration(4);
  assert.equal(await editor, undefined);
});

test("remote UI renews owned deadlines and supports Never", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request), 100);
  const ui = bridge.context("session-1", 7);

  const renewed = ui.select("Choose", ["A"]);
  const renewedRequest = requests.at(-1)!;
  assert.equal(renewedRequest.timeoutSeconds, 1);
  const firstExpiry = renewedRequest.expiresAt;
  await new Promise(resolve => setTimeout(resolve, 30));
  const renewedExpiry = bridge.keepAlive(renewedRequest.requestId, 7);
  assert.equal(renewedExpiry, renewedRequest.expiresAt);
  assert.notEqual(renewedExpiry, firstExpiry);
  await new Promise(resolve => setTimeout(resolve, 30));
  bridge.answer({ requestId: renewedRequest.requestId, sessionGeneration: 7, method: "select", value: "A" });
  assert.equal(await renewed, "A");
  assert.throws(() => bridge.keepAlive(renewedRequest.requestId, 7), /unknown or expired/);

  const never = ui.confirm("Confirm", "Proceed?", { timeout: 0 });
  const neverRequest = requests.at(-1)!;
  assert.equal(neverRequest.timeoutSeconds, undefined);
  await new Promise(resolve => setTimeout(resolve, 120));
  bridge.keepAlive(neverRequest.requestId, 7);
  bridge.answer({ requestId: neverRequest.requestId, sessionGeneration: 7, method: "confirm", confirmed: true });
  assert.equal(await never, true);
});

test("remote UI returns one bounded answer for every questionnaire item", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  const ui = bridge.context("session-1", 8) as ReturnType<RemoteUiBridge["context"]> & {
    questionnaire(questions: Array<{ question: string; options: string[] }>): Promise<string[] | undefined>;
  };
  const pending = ui.questionnaire([
    { question: "Scope?", options: ["Small", "Large"] },
    { question: "Deploy?", options: ["Now", "Later"] },
  ]);
  const request = requests.at(-1)!;
  bridge.answer({
    requestId: request.requestId,
    sessionGeneration: 8,
    method: "questionnaire",
    answers: ["Small", "Later"],
  });
  assert.deepEqual(await pending, ["Small", "Later"]);
});

test("remote UI allows one active dialog and fails concurrent safety prompts closed", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge(request => requests.push(request));
  const ui = bridge.context("session-1", 5);
  const first = ui.confirm("Guard", "Allow risky action?");
  assert.equal(await ui.confirm("Guard", "Allow another action?"), false);
  assert.equal(requests.length, 1);
  bridge.answer({ requestId: requests[0].requestId, sessionGeneration: 5, method: "confirm", confirmed: false });
  assert.equal(await first, false);
});
