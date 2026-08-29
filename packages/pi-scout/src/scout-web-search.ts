// Adapted from pi-web-access's OpenAI/Codex and zero-config Exa search providers.
// Copyright (c) 2025 Nico Bailon. MIT licensed; see THIRD_PARTY_NOTICES.md.
import { BlockList, isIP } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EXA_SEARCH_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const EXA_SEARCH_ORIGIN = new URL(EXA_SEARCH_URL).origin;
const EXA_SEARCH_TOOL = "web_search_exa";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_REDIRECTS = 2;
const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 300;
const SEARCH_PROVIDERS = ["auto", "openai", "exa"] as const;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
type McpResponse = {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
};
type OpenAIAuth = { provider: "openai-codex" | "openai"; apiKey: string; model: string };
export type ScoutSearchResult = { title: string; url: string; snippet: string };
export type ScoutSearchResponse = { provider: "openai" | "exa"; results: ScoutSearchResult[] };

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");

function publicLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(host);
  if (family === 4) return !blockedV4.check(host, "ipv4");
  if (family !== 6 || host.toLowerCase().startsWith("::ffff:")) return false;
  return globalV6.check(host, "ipv6") && !blockedV6.check(host, "ipv6");
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function resultUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname)
      return undefined;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if ((port !== "80" && port !== "443") || url.href.length > 2048) return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const family = isIP(host);
    if (
      family
        ? !publicLiteral(host)
        : !host.includes(".") ||
          host.endsWith(".localhost") ||
          host.endsWith(".local") ||
          host.endsWith(".internal") ||
          host.endsWith(".home.arpa")
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error("Search response exceeded its size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Search response exceeded its size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchExa(body: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<Response> {
  let current = new URL(EXA_SEARCH_URL);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchImpl(current, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "x-exa-source": "pylon",
      },
      body,
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) throw new Error("Search endpoint redirected too many times");
    const next = new URL(location, current);
    if (next.origin !== EXA_SEARCH_ORIGIN) throw new Error("Search endpoint redirected outside Exa");
    current = next;
  }
  throw new Error("Search endpoint redirected too many times");
}

function mcpPayload(body: string): McpResponse {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const value = JSON.parse(line.slice(5).trim()) as McpResponse;
      if (value.result || value.error) return value;
    } catch {}
  }
  try {
    const value = JSON.parse(body) as McpResponse;
    if (value.result || value.error) return value;
  } catch {}
  throw new Error("Exa returned an invalid search response");
}

function providerText(payload: McpResponse): string {
  if (payload.error)
    throw new Error(`Exa search failed${typeof payload.error.code === "number" ? ` (${payload.error.code})` : ""}`);
  const text = payload.result?.content?.find(item => item.type === "text" && item.text?.trim())?.text;
  if (payload.result?.isError || !text) throw new Error("Exa returned no search results");
  return text;
}

function parseTextResults(text: string, count: number): ScoutSearchResult[] {
  const results: ScoutSearchResult[] = [];
  const seen = new Set<string>();
  for (const block of text.split(/(?=^Title: )/m)) {
    const title = boundedText(block.match(/^Title: (.+)$/m)?.[1] ?? "", 240);
    const url = resultUrl(block.match(/^URL: (.+)$/m)?.[1] ?? "");
    if (!title || !url || seen.has(url)) continue;
    const content = block.match(/\n(?:Highlights:|Text:)\s*\n([\s\S]*?)(?:\n---\s*$|$)/)?.[1] ?? "";
    seen.add(url);
    results.push({ title, url, snippet: boundedText(content, 600) });
    if (results.length >= count) break;
  }
  return results;
}

function parseExaResults(text: string, count: number): ScoutSearchResult[] {
  try {
    const value = JSON.parse(text) as {
      results?: Array<{ title?: unknown; url?: unknown; text?: unknown; highlights?: unknown }>;
    };
    if (Array.isArray(value.results)) {
      const results: ScoutSearchResult[] = [];
      const seen = new Set<string>();
      for (const item of value.results) {
        const url = resultUrl(typeof item.url === "string" ? item.url : "");
        if (!url || seen.has(url)) continue;
        const highlights = Array.isArray(item.highlights)
          ? item.highlights.filter((part): part is string => typeof part === "string").join(" ")
          : "";
        seen.add(url);
        results.push({
          title: boundedText(typeof item.title === "string" ? item.title : url, 240),
          url,
          snippet: boundedText(highlights || (typeof item.text === "string" ? item.text : ""), 600),
        });
        if (results.length >= count) break;
      }
      if (results.length) return results;
    }
  } catch {}
  return parseTextResults(text, count);
}

export async function searchExa(
  query: string,
  maxResults = 5,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<ScoutSearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH)
    throw new Error(`Search query must contain 1 to ${MAX_QUERY_LENGTH} characters`);
  const count = Number.isInteger(maxResults) ? Math.max(1, Math.min(maxResults, MAX_RESULTS)) : 5;
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: EXA_SEARCH_TOOL, arguments: { query: normalizedQuery, numResults: count } },
  });
  const response = await fetchExa(request, requestSignal(signal), fetchImpl);
  if (!response.ok) throw new Error(`Exa search failed with status ${response.status}`);
  const results = parseExaResults(providerText(mcpPayload(await readBoundedBody(response))), count);
  if (!results.length) throw new Error("Exa returned no parseable search results");
  return results;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function accountId(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const value = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickOpenAIModel<T extends { id: string }>(models: T[]): T | undefined {
  const eligible = models
    .filter(model => !model.id.split("-").some(part => part === "pro" || part === "ultra"))
    .sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true }));
  return (
    eligible.find(model => model.id.includes("terra")) ??
    eligible.find(model => /^gpt-\d+(\.\d+)?$/.test(model.id)) ??
    eligible[0]
  );
}

export async function resolveOpenAIAuth(ctx?: ExtensionContext): Promise<OpenAIAuth | undefined> {
  if (!ctx) return undefined;
  let models: ReturnType<typeof ctx.modelRegistry.getAvailable>;
  try {
    models = ctx.modelRegistry.getAvailable();
  } catch {
    throw new Error("OpenAI credential registry unavailable");
  }
  const candidates = (["openai-codex", "openai"] as const).flatMap(provider => {
    const model = pickOpenAIModel(models.filter(candidate => candidate.provider === provider));
    return model ? [{ provider, model }] : [];
  });
  if (!candidates.length) return undefined;
  for (const { provider, model } of candidates) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok && auth.apiKey) return { provider, apiKey: auth.apiKey, model: model.id };
    } catch {}
  }
  throw new Error("OpenAI credential resolution failed");
}

function parseOpenAIOutput(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed) as { output?: unknown };
      return Array.isArray(value.output) ? value.output : [];
    } catch {
      throw new Error("OpenAI returned invalid search JSON");
    }
  }
  const items: unknown[] = [];
  let completed: unknown[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const value = JSON.parse(data) as { type?: unknown; item?: unknown; response?: { output?: unknown } };
      if (value.type === "response.output_item.done" && value.item) items.push(value.item);
      if (
        (value.type === "response.done" || value.type === "response.completed") &&
        Array.isArray(value.response?.output)
      )
        completed = value.response.output;
    } catch {}
  }
  const output = completed?.length ? completed : items;
  if (!output.length) throw new Error("OpenAI returned no parseable search output");
  return output;
}

function snippetAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number") return "";
  return boundedText(
    text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
    300,
  );
}

/** Narrows an untrusted provider payload node to a readable record. */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

type AddResult = (url: unknown, title: unknown, snippet?: string) => void;

/** Sources the model cited inline in its answer text, with the surrounding prose as the snippet. */
function addCitationResults(output: unknown[], add: AddResult): void {
  for (const item of output) {
    const message = asObject(item);
    if (message?.type !== "message" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const value = asObject(part);
      if (!value || !Array.isArray(value.annotations)) continue;
      const text = typeof value.text === "string" ? value.text : "";
      for (const annotation of value.annotations) {
        const citation = asObject(annotation);
        if (citation?.type !== "url_citation") continue;
        add(citation.url, citation.title, snippetAround(text, citation.start_index, citation.end_index));
      }
    }
  }
}

/** Raw sources the web_search tool reported, which may include pages the answer never cited. */
function addSearchCallResults(output: unknown[], add: AddResult): void {
  for (const item of output) {
    const call = asObject(item);
    if (call?.type !== "web_search_call") continue;
    const actionSources = asObject(call.action)?.sources;
    for (const group of [actionSources, call.sources, call.results]) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        const record = asObject(source);
        if (record) add(record.url ?? record.source_website_url, record.title ?? record.caption);
      }
    }
  }
}

function parseOpenAIResults(output: unknown[], count: number): ScoutSearchResult[] {
  const results: ScoutSearchResult[] = [];
  const seen = new Set<string>();
  const add: AddResult = (rawUrl, rawTitle, snippet = "") => {
    const url = resultUrl(typeof rawUrl === "string" ? rawUrl : "");
    if (!url || seen.has(url) || results.length >= count) return;
    seen.add(url);
    results.push({
      title: boundedText(typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : url, 240),
      url,
      snippet: boundedText(snippet, 600),
    });
  };
  // Cited sources first: they carry snippets and are what the model actually relied on.
  addCitationResults(output, add);
  addSearchCallResults(output, add);
  return results;
}

export async function searchOpenAI(
  query: string,
  maxResults: number,
  auth: OpenAIAuth,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<ScoutSearchResult[]> {
  const codex = auth.provider === "openai-codex";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
  };
  if (codex) {
    const id = accountId(auth.apiKey);
    if (id) headers["chatgpt-account-id"] = id;
    headers.originator = "pi";
  }
  const response = await fetchImpl(codex ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL, {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({
      model: auth.model,
      instructions: `Find around ${maxResults} relevant public sources. Return concise source citations.`,
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      store: false,
      stream: true,
      tool_choice: "required",
      parallel_tool_calls: true,
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`OpenAI search failed with status ${response.status}`);
  const results = parseOpenAIResults(parseOpenAIOutput(await readBoundedBody(response)), maxResults);
  if (!results.length) throw new Error("OpenAI returned no parseable search results");
  return results;
}

export async function searchWeb(
  query: string,
  maxResults = 5,
  provider: SearchProvider = "auto",
  signal?: AbortSignal,
  ctx?: ExtensionContext,
  fetchImpl: FetchLike = fetch,
): Promise<ScoutSearchResponse> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH)
    throw new Error(`Search query must contain 1 to ${MAX_QUERY_LENGTH} characters`);
  const count = Number.isInteger(maxResults) ? Math.max(1, Math.min(maxResults, MAX_RESULTS)) : 5;
  if (provider !== "exa") {
    const auth = await resolveOpenAIAuth(ctx);
    if (auth)
      return { provider: "openai", results: await searchOpenAI(normalizedQuery, count, auth, signal, fetchImpl) };
    if (provider === "openai")
      throw new Error("OpenAI search is unavailable; sign in with /login or configure OPENAI_API_KEY");
  }
  return { provider: "exa", results: await searchExa(normalizedQuery, count, signal, fetchImpl) };
}

export function formatResults(
  provider: "openai" | "exa",
  results: ScoutSearchResult[],
): { text: string; shown: number; truncated: boolean } {
  const lines = [
    `${provider === "openai" ? "OpenAI" : "Exa"} search results (untrusted URL candidates; open pages with scout_browser):`,
  ];
  let shown = 0;
  for (const result of results) {
    const block = [
      `${shown + 1}. ${result.title}`,
      `   ${result.url}`,
      ...(result.snippet ? [`   ${result.snippet}`] : []),
    ];
    if (Buffer.byteLength([...lines, ...block].join("\n")) > MAX_OUTPUT_BYTES) break;
    lines.push(...block);
    shown++;
  }
  return { text: lines.join("\n"), shown, truncated: shown < results.length };
}

export default function scoutWebSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "scout_web_search",
    label: "Web Scout Search",
    description:
      "Find public-web pages matching a query and return bounded titles, URLs, and snippets for discovery. This tool does not open pages or verify their contents; open useful results with scout_browser before citing them. The default auto provider uses available OpenAI/Codex subscription or API-key auth, otherwise keyless Exa. Each query is sent to the selected provider.",
    promptSnippet: "Find public-web URL candidates, then open and verify useful results with scout_browser",
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: "Focused public-web search query",
        }),
        maxResults: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_RESULTS,
            default: 5,
            description: "Maximum URL candidates to return",
          }),
        ),
        provider: Type.Optional(
          StringEnum(SEARCH_PROVIDERS, {
            default: "auto",
            description: "Search provider; auto prefers available OpenAI/Codex auth and otherwise uses Exa",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const searched = await searchWeb(params.query, params.maxResults, params.provider, signal, ctx);
        const formatted = formatResults(searched.provider, searched.results);
        return {
          content: [{ type: "text" as const, text: formatted.text }],
          details: {
            provider: searched.provider,
            resultCount: searched.results.length,
            shown: formatted.shown,
            truncated: formatted.truncated,
          },
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Web search cancelled");
        const message = error instanceof Error ? error.message : "Web search failed";
        throw new Error(message.slice(0, 300));
      }
    },
  });
}
