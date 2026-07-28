import test from "node:test";
import assert from "node:assert/strict";
import { RemoteUiBridge, type UiRequest } from "../src/server/pi/remote-ui-context.ts";

test("remote UI correlates every RPC dialog and validates responses", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge((request) => requests.push(request), 1_000);
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

  const edited = ui.editor("Edit", "before");
  bridge.answer({ requestId: requests.at(-1)!.requestId, sessionGeneration: 3, method: "editor", value: "after" });
  assert.equal(await edited, "after");

  const questionnaire = (ui as any).questionnaire([
    { question: "Scope?", options: [{ label: "API" }, { label: "All" }] },
    { question: "Ship?", options: [{ label: "Now" }, { label: "Later" }] },
  ]);
  const questionnaireRequest = requests.at(-1)!;
  assert.equal(questionnaireRequest.method, "questionnaire");
  assert.deepEqual(questionnaireRequest.payload.questions, [
    { question: "Scope?", options: ["API", "All"] },
    { question: "Ship?", options: ["Now", "Later"] },
  ]);
  bridge.answer({
    requestId: questionnaireRequest.requestId,
    sessionGeneration: 3,
    method: "questionnaire",
    answers: ["API", "Custom date"],
  });
  assert.deepEqual(await questionnaire, ["API", "Custom date"]);

  const invalidQuestionnaire = (ui as any).questionnaire([
    { question: "Scope?", options: [{ label: "API" }, { label: "All" }] },
    { question: "Ship?", options: [{ label: "Now" }, { label: "Later" }] },
  ]);
  const invalidRequest = requests.at(-1)!;
  assert.throws(() => bridge.answer({
    requestId: invalidRequest.requestId,
    sessionGeneration: 3,
    method: "questionnaire",
    answers: ["API"],
  }), /one bounded answer per question/);
  bridge.answer({
    requestId: invalidRequest.requestId,
    sessionGeneration: 3,
    method: "questionnaire",
    cancelled: true,
  });
  assert.equal(await invalidQuestionnaire, undefined);

  assert.throws(() => bridge.answer({
    requestId: "missing",
    sessionGeneration: 3,
    method: "confirm",
    confirmed: true,
  }), /unknown or expired/);
});

test("remote UI fails closed on abort, timeout, and generation cancellation", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge((request) => requests.push(request), 10);
  const ui = bridge.context("session-1", 4);

  const controller = new AbortController();
  const confirmation = ui.confirm("Confirm", "Proceed?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirmation, false);

  const expired = ui.select("Choose", ["A"], { timeout: 1 });
  const expiredRequest = requests.at(-1)!;
  assert.equal(await expired, undefined);
  assert.throws(() => bridge.answer({ requestId: expiredRequest.requestId, sessionGeneration: 4, method: "select", value: "A" }), /unknown or expired/);

  const editor = ui.editor("Edit");
  bridge.cancelGeneration(4);
  assert.equal(await editor, undefined);
});

test("remote UI allows one active dialog and fails concurrent safety prompts closed", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge((request) => requests.push(request));
  const ui = bridge.context("session-1", 5);
  const first = ui.confirm("Guard", "Allow risky action?");
  assert.equal(await ui.confirm("Guard", "Allow another action?"), false);
  assert.equal(requests.length, 1);
  bridge.answer({ requestId: requests[0].requestId, sessionGeneration: 5, method: "confirm", confirmed: false });
  assert.equal(await first, false);
});

test("remote UI exposes bounded fire-and-forget methods and exact neutral TUI methods", async () => {
  const requests: UiRequest[] = [];
  const bridge = new RemoteUiBridge((request) => requests.push(request));
  const ui = bridge.context("session-1", 6);

  ui.notify("done", "info");
  ui.setStatus("probe", "ready");
  ui.setWidget("probe", ["line"]);
  ui.setTitle("Pylon");
  ui.setEditorText("text");

  assert.deepEqual(requests.map((request) => request.method), [
    "notify", "setStatus", "setWidget", "setTitle", "setEditorText",
  ]);
  assert.deepEqual(bridge.snapshot(), {
    notifications: [{ id: requests[0].requestId, message: "done", type: "info", occurredAt: requests[0].createdAt }],
    statuses: [{ key: "probe", text: "ready" }],
    widgets: [{ key: "probe", lines: ["line"], placement: undefined }],
    title: "Pylon",
    editorText: "text",
    editorRevision: 1,
  });
  assert.equal(ui.getEditorText(), "");
  assert.equal(ui.getToolsExpanded(), false);
  assert.deepEqual(ui.getAllThemes(), []);
  assert.equal(ui.getTheme("dark"), undefined);
  assert.equal(ui.theme, undefined);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.deepEqual(ui.setTheme("dark"), { success: false, error: "Theme switching is unavailable in remote UI mode" });
  const unsubscribe = ui.onTerminalInput(() => undefined);
  assert.equal(typeof unsubscribe, "function");
  assert.equal(unsubscribe(), undefined);
  assert.equal(ui.setToolsExpanded(true), undefined);
  assert.equal(ui.setEditorComponent(undefined), undefined);
  assert.equal(ui.setFooter(undefined), undefined);
  assert.equal(ui.setHeader(undefined), undefined);
  assert.equal(await ui.custom(async () => { throw new Error("must not render"); }), undefined);
});
