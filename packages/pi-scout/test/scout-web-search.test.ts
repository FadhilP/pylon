import test from "node:test";
import assert from "node:assert/strict";
import scoutWebSearchExtension, { formatResults, searchExa, searchWeb } from "../src/scout-web-search.ts";

const providerText = `Title: Docs & API
URL: https://example.com/docs
Highlights:
Official reference.

---

Title: Duplicate
URL: https://example.com/docs
Highlights:
Duplicate.

---

Title: Guide
URL: https://developer.example/guide
Highlights:
Guide text.

---

Title: Credentials
URL: https://user:pass@example.com/private
Highlights:
Blocked.

Title: Loopback
URL: http://127.0.0.1/admin
Highlights:
Blocked.

---

Title: Private host
URL: http://metadata.google.internal/latest
Highlights:
Blocked.

---

`;
const mcpResponse = (text = providerText) => `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n\n`;

function context(models: Array<{ provider: string; id: string }>, apiKey?: string) {
  return {
    modelRegistry: {
      getAvailable() { return apiKey ? models : []; },
      async getApiKeyAndHeaders() {
        return apiKey ? { ok: true, apiKey, headers: { "x-auth-source": "test", ignored: null } } : { ok: false, error: "missing" };
      },
    },
  } as any;
}

function jwt(account = "account-123") {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function openAIResponse() {
  const message = {
    type: "message",
    content: [{
      type: "output_text",
      text: "See Docs for the current reference.",
      annotations: [{
        type: "url_citation",
        url: "https://example.com/docs?utm_source=openai&version=current",
        title: "Current docs",
        start_index: 4,
        end_index: 8,
      }],
    }],
  };
  const sourceCall = {
    type: "web_search_call",
    action: { sources: [
      { url: "https://example.com/docs?version=current", title: "Duplicate" },
      { url: "https://developer.example/guide", title: "Guide" },
    ] },
  };
  return `data: ${JSON.stringify({ type: "response.output_item.done", item: message })}\n\ndata: ${JSON.stringify({ type: "response.output_item.done", item: sourceCall })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`;
}

test("Exa MCP search sends a bounded request and parses unique public URL candidates", async () => {
  let requested = "";
  let requestBody: any;
  const results = await searchExa("android gradle plugin", 8, undefined, async (input, init) => {
    requested = String(input);
    requestBody = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "POST");
    return new Response(mcpResponse(), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  assert.equal(new URL(requested).hostname, "mcp.exa.ai");
  assert.deepEqual(requestBody.params, { name: "web_search_exa", arguments: { query: "android gradle plugin", numResults: 8 } });
  assert.deepEqual(results, [
    { title: "Docs & API", url: "https://example.com/docs", snippet: "Official reference." },
    { title: "Guide", url: "https://developer.example/guide", snippet: "Guide text." },
  ]);
});

test("Exa search parses JSON tool payloads", async () => {
  const text = JSON.stringify({ results: [{ title: "Reference", url: "https://example.com/reference", highlights: ["First", "Second"] }] });
  const results = await searchExa("query", 1, undefined, async () => new Response(mcpResponse(text)));
  assert.deepEqual(results, [{ title: "Reference", url: "https://example.com/reference", snippet: "First Second" }]);
});

test("Exa search rejects off-origin redirects, oversized bodies, and malformed responses", async () => {
  await assert.rejects(searchExa("query", 5, undefined, async () => new Response(null, {
    status: 307,
    headers: { location: "https://example.com/search" },
  })), /outside Exa/);

  await assert.rejects(searchExa("query", 5, undefined, async () => new Response("x", {
    status: 200,
    headers: { "content-length": String(256 * 1024 + 1) },
  })), /size limit/);

  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(searchExa("query", 5, undefined, async () => new Response(oversized)), /size limit/);
  await assert.rejects(searchExa("query", 5, undefined, async () => new Response("not rpc")), /invalid search response/);
  await assert.rejects(searchExa("", 5, undefined, async () => new Response(mcpResponse())), /1 to 300/);
});

test("auto search uses an existing OpenAI Codex subscription and returns only bounded citations", async () => {
  let requested = "";
  let requestBody: any;
  let requestHeaders: Headers;
  const token = jwt();
  const searched = await searchWeb(
    "current API docs",
    5,
    "auto",
    undefined,
    context([{ provider: "openai-codex", id: "gpt-5.4" }], token),
    async (input, init) => {
      requested = String(input);
      requestBody = JSON.parse(String(init?.body));
      requestHeaders = new Headers(init?.headers);
      assert.equal(init?.redirect, "error");
      return new Response(openAIResponse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  );
  assert.equal(requested, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(requestHeaders!.get("authorization"), `Bearer ${token}`);
  assert.equal(requestHeaders!.get("chatgpt-account-id"), "account-123");
  assert.equal(requestHeaders!.get("originator"), "pi");
  assert.equal(requestHeaders!.get("x-auth-source"), null);
  assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
  assert.equal(requestBody.store, false);
  assert.deepEqual(searched, {
    provider: "openai",
    results: [
      { title: "Current docs", url: "https://example.com/docs?version=current", snippet: "See Docs for the current reference." },
      { title: "Guide", url: "https://developer.example/guide", snippet: "" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(searched), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("registry provider controls the OpenAI endpoint and arbitrary auth headers are not forwarded", async () => {
  let endpoint = "";
  let headers: Headers;
  await searchWeb("query", 1, "openai", undefined, context([{ provider: "openai", id: "gpt-5.4" }], jwt()), async (input, init) => {
    endpoint = String(input);
    headers = new Headers(init?.headers);
    return new Response(openAIResponse());
  });
  assert.equal(endpoint, "https://api.openai.com/v1/responses");
  assert.equal(headers!.get("chatgpt-account-id"), null);
  assert.equal(headers!.get("originator"), null);
  assert.equal(headers!.get("x-auth-source"), null);
});

test("auto search fails closed when configured OpenAI credential resolution errors", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(mcpResponse()); };
  await assert.rejects(searchWeb("query", 1, "auto", undefined, {
    modelRegistry: { getAvailable() { throw new Error("registry broke"); } },
  } as any, fetchImpl), /credential registry unavailable/);
  await assert.rejects(searchWeb("query", 1, "auto", undefined, {
    modelRegistry: {
      getAvailable() { return [{ provider: "openai", id: "gpt-5.4" }]; },
      async getApiKeyAndHeaders() { throw new Error("refresh failed"); },
    },
  } as any, fetchImpl), /credential resolution failed/);
  assert.equal(requests, 0);
});

test("formatted search output enforces its final byte cap", () => {
  const results = Array.from({ length: 8 }, (_, index) => ({
    title: "t".repeat(240),
    url: `https://example.com/${"p".repeat(1800)}${index}`,
    snippet: "s".repeat(600),
  }));
  const formatted = formatResults("exa", results);
  assert.ok(Buffer.byteLength(formatted.text) <= 12 * 1024);
  assert.equal(formatted.truncated, true);
  assert.ok(formatted.shown < results.length);
});

test("auto search uses Exa only when OpenAI auth is unavailable and explicit OpenAI fails closed", async () => {
  const missing = context([{ provider: "openai", id: "gpt-5.4" }]);
  let requests = 0;
  const searched = await searchWeb("query", 1, "auto", undefined, missing, async (input) => {
    requests++;
    assert.equal(new URL(String(input)).hostname, "mcp.exa.ai");
    return new Response(mcpResponse());
  });
  assert.equal(searched.provider, "exa");
  assert.equal(requests, 1);
  await assert.rejects(searchWeb("query", 1, "openai", undefined, missing, async () => {
    requests++;
    return new Response(mcpResponse());
  }), /sign in with \/login/);
  assert.equal(requests, 1);
});

