# pi-scout

Bounded repository reconnaissance and isolated public-web research for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-scout. Run `/reload` after installation.

## Configuration

Scout stays inactive until you select a child model with `/scout provider/model-id[:thinking]` or `/scout`, or run `/scout reset` to use the current main model. Example: `/scout openai/gpt-5:medium`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, Scout follows the current main thinking level.

- `/scout disable` disables repository and web scouts.
- With Pylon, configured Repository Scout stays active while Web Scout remains deferred until `search_tools` activates it. Standalone Scout keeps both configured tools active.
- `/scout reset` enables all scouts using the current main model and thinking level.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

## Repository Scout

### When to Use It

Pi receives `repo_scout(task, retryReason?)`. The main model should default to it for non-local discovery, unfamiliar code, architecture mapping, data-flow mapping, and cross-file impact—not only before edits, but also before plans, diagnoses, reviews, or conclusions. Known-file self-contained work should skip Scout. Scout gathers evidence; the main model owns evaluation, severity, exploitability, priority, architecture choices, recommendations, and final conclusions.

### Task Shape and Evidence

Each task keeps useful context through four explicit parts: an observable action, concrete anchors or bounded scope, requested evidence, and a finite stopping boundary. Exact symbols are not mandatory: paths, packages, patterns, trust boundaries, inputs, and sinks are valid anchors. The stopping boundary may include directly relevant imports, registries, configuration, tests, or indirect dispatch needed to evidence the trace.

Normative goals become factual reconnaissance without offloading the decision. Bad: `determine whether presentationHelper should become the canonical render model and design its migration`. Better: `trace presentationHelper inputs, outputs, callers, data-shape divergences, unsupported fields, and tests; cite exact ranges and stop at directly relevant routes and helpers`. Scout may report observable duplication, missing checks, divergent limits, uncovered paths, and uncertainty; the main model evaluates quality, cost, severity, priority, architecture, and recommendations.

Before calling Scout, the main model performs only enough orientation to frame a concrete Scout task—usually three to six repository-inspection operations and never more than ten. Nested or parallel operations count separately, and Scout should be called before further exploration once that ceiling is reached. On each turn, pi-scout inspects Pi's selected tools and adds guidance naming only tools currently visible to the model. This can include pi-discover's `symbol_search`, `code_search`, `relationship_graph`, `fd`, and `rg`, or Pi's built-in `find`, `grep`, and `read` when pi-scout is installed alone. Partial installs and deferred tool activation work per tool rather than per package. Orientation produces concrete anchors and a sharper Scout task without duplicating Scout's tracing; reliable exact anchors skip it.

Calls are unlimited within one original user prompt and every call uses a fresh child session. An initial self-contained call sends no parent conversation context. A call with `retryReason` is a follow-up and receives a redacted, bounded parent handoff, but prior Scout reports are not inherited. Never use only `using the prior map`: copy relevant prior paths, symbols, factual findings, changed constraints, and unresolved gaps into `task` or `retryReason`, not the whole report. Follow up only for a real gap, missing edit anchor, or repository-state change, and combine related gaps into one task.

Scout returns citation-first exact `path:start-end` evidence with excerpts of at most 8 lines, a soft report target of about 8 KiB, and a hard 12 KiB final-report cap. Report blocks are never clipped: complete blank-line-separated blocks are retained or omitted under the global cap, with an omission marker. Findings, data flow, and affected files avoid repeating the same evidence; omissions and uncertainty belong in Gaps. The main model treats cited ranges as sufficient for read-only evaluation by default. It rereads only for an exact edit, a stated gap/conflict, or changed repository state. Known-file micro-edits should skip Scout.

The isolated child always loads Scout-owned read-only `read` and `search_excerpt` plus Pi's built-in `grep`, `find`, and `ls`. When pi-discover is present in the same bundle, Scout loads its advertised child entrypoint and also exposes `rg`, `fd`, and `relationship_graph`; absent, malformed, or duplicate providers fail closed and those tools remain unavailable. `search_excerpt` stays Scout-specific: it returns deterministic line-numbered matching excerpts plus bounded context, tries `rg` then `grep`, and accepts workspace-relative `path`, `pattern`, optional `glob`, and up to three context lines. Child extension output is capped at 24 KiB and explicitly reports omissions; oversized cited excerpt results are sampled deterministically across files instead of keeping only the head. The child has no shell, mutation tools, unrelated extensions, skills, or context files. There is no hard child turn cap. Activity history retains at most 100 events. Timeouts fail nonfatally; retry with a focused follow-up task.

## Web Scout

### Browser Isolation

Pi receives `web_scout(task, startUrls?, maxPages?)` for browser-rendered public-web evidence. The main model may use it when the user explicitly requests web research or when a task reasonably requires current external information unavailable in the repository or local documentation—for example official docs, API references, dependency behavior, release notes, standards, or current facts. It should skip Web Scout when local evidence is sufficient. Calls launch immediately without Pi Guard or per-call confirmation because every run uses a fresh isolated browser with no user state. The selected provider still receives the task and returned page text; public sites receive browser traffic, network address, and research terms.

Web Scout launches a headless temporary Helios-owned browser with no user cookies, tabs, profiles, or logins. A separate child Pi receives only `scout_browser` with `navigate`, `snapshot`, `continue`, `follow`, and `back`. Truncated snapshot cursors are consumed immediately before another page action. If Playwright cannot snapshot an otherwise loaded plain-text, Markdown, or JSON document, a fixed read-only browser extraction returns bounded redacted text through the same isolated session; model-supplied scripts remain unavailable. When the optional **OpenAI / Exa search for Web Scout** package setting is enabled, the child also receives `scout_web_search` for bounded URL discovery. Its default `auto` provider uses an existing Pi `openai-codex` `/login` subscription or `OPENAI_API_KEY` when available and otherwise uses Exa's keyless MCP endpoint; callers may explicitly select `openai` or `exa`. Result pages must still be verified through `scout_browser`. It cannot attach to user browsers, click arbitrary controls, fill forms, execute model-supplied scripts, access storage through tools, upload, download, or capture screenshots. Public pages may execute their own JavaScript and use temporary isolated cookies/storage; all are discarded when browser closes. Browser and child session close after each call.

Browser traffic passes through a randomized run-scoped loopback capability proxy. Each HTTP request and HTTPS tunnel resolves every destination, rejects mixed or non-public DNS answers, connects directly to the validated address, and permits only ports 80/443. Loopback, private, link-local, carrier-grade NAT, multicast, documentation, transition, reserved, and metadata ranges are blocked for explicit navigation, redirects, and subresources. QUIC, non-proxied WebRTC, service workers, downloads, and proxy loopback bypass are disabled. The optional search tool contacts only OpenAI's Responses endpoint or Exa's fixed HTTPS MCP endpoint and returns untrusted URL candidates; it never fetches result pages itself.

### Budgets and Reports

Default successful-navigation budget is 8; accepted range is 1–12. Failed page operations still consume action budget but no longer consume navigation budget. Redirects and subresources share bounded proxy request/byte budgets but are not counted as separate tool navigations. Calls also have a bounded action budget and 15-minute hard timeout; at 14 minutes the child is steered to stop research and return its report. Reports cite URLs, titles, access date, short supporting excerpts, and gaps. Web pages remain untrusted data.

## Privacy and Cost

Every child call costs the selected model's rates. Cache savings are never assumed. Repository Scout sends its task to the selected provider; only retryReason follow-ups also send bounded recent parent context. Web Scout sends its task and returned public-page text, while visited sites receive browser traffic, network address, and any research terms used in navigation; it never receives parent-session context. When optional search is enabled, the selected OpenAI or Exa search provider receives each query and may return indexed snippets. Session search can send text from other workspaces. Redaction is defense in depth, not proof of secrecy.

Repository and Web Scout have a $1.0 reported-cost discovery ceiling per call by default. Set `PI_SCOUT_MAX_COST_USD` to a positive finite USD amount to override it, or `0` to disable the ceiling. When a tool-use response reaches the ceiling, Scout is steered once to return its compact cited findings; that one final report response may raise the total beyond the ceiling. There are no checkpoints. This relies on model-reported usage cost and does not guarantee actual provider billing.

Repository timeout is 15 minutes by default. Set `PI_SCOUT_TIMEOUT_MS` to `1..7200000` milliseconds to override it. Failures are nonfatal. Pi extensions run with full user permissions; review source before installation.

## Attribution

The optional OpenAI/Codex and Exa search adapters are adapted from [pi-web-access](https://github.com/nicobailon/pi-web-access) by Nico Bailon under the MIT License. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
