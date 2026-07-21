# pi-scout

Bounded repository reconnaissance, consent-gated isolated public-web research, and explicit Pi-session search for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-scout. Run `/reload` after installation.

## Configuration

Scout stays inactive until you select a child model with `/scout provider/model-id[:thinking]` or `/scout`, or run `/scout reset` to use the current main model. Example: `/scout openai/gpt-5:medium`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, Scout follows the current main thinking level.

- `/scout disable` disables repository, web, and session scouts.
- With Pylon, configured Repository Scout stays active while Web Scout remains deferred until `search_tools` activates it. Standalone Scout keeps both configured tools active.
- `/scout reset` enables all scouts using the current main model and thinking level.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

## Repository Scout

Pi receives `repo_scout(task, retryReason?)`. The main model should call it before edits for non-local discovery, architecture or data-flow mapping, and cross-file impact. Scout gathers evidence; the main model owns evaluation, severity, exploitability, priority, architecture choices, and final conclusions.

Each task keeps useful context through four explicit parts: an observable action, concrete anchors or bounded scope, requested evidence, and a finite stopping boundary. Exact symbols are not mandatory: paths, packages, patterns, trust boundaries, inputs, and sinks are valid anchors. The stopping boundary may include directly relevant imports, registries, configuration, tests, or indirect dispatch needed to evidence the trace.

Broad goals become factual reconnaissance without losing scope constraints. Bad: `inspect all packages for token-cost or quality opportunities`. Better: `Across packages/a and packages/b, trace context assembly, redaction, and truncation; cite definitions, callers, shared helpers, configured limits, factual differences, and unresolved coverage gaps; stop when directly relevant imports, registries, config, and tests needed to evidence those flows are covered`. Scout may report observable duplication, missing checks, divergent limits, uncovered paths, and uncertainty; the main model evaluates quality, cost, severity, priority, architecture, and recommendations.

When Scout is needed but neither the user request nor current context supplies a concrete path, package, symbol, pattern, boundary, input, or sink, the main model first performs a bounded read-only orientation pass with a few targeted `fd`, `rg`, or narrow `read` operations. It stops once enough anchors exist for a concrete Scout task; it does not inventory the repository or duplicate Scout tracing. Existing reliable anchors skip this pass.

Calls are unlimited within one original user prompt and every call uses a fresh child session. An initial self-contained call sends no parent conversation context. A call with `retryReason` is a follow-up and receives a redacted, bounded parent handoff, but prior Scout reports are not inherited. Never use only `using the prior map`: copy relevant prior paths, symbols, factual findings, changed constraints, and unresolved gaps into `task` or `retryReason`, not the whole report. Follow up only for a real gap, missing edit anchor, or repository-state change, and combine related gaps into one task.

Scout returns citation-first exact `path:start-end` evidence with excerpts of at most 8 lines, a soft report target of about 8 KiB, and a hard 12 KiB final-report cap. Findings, data flow, and affected files avoid repeating the same evidence; omissions and uncertainty belong in Gaps. The main model treats cited ranges as sufficient for read-only evaluation by default. It rereads only for an exact edit, a stated gap/conflict, or changed repository state. Known-file micro-edits should skip Scout.

The isolated child always loads Scout-owned read-only `read` and `search_excerpt` plus Pi's built-in `grep`, `find`, and `ls`. When pi-discover is present in the same bundle, Scout loads its advertised child entrypoint and also exposes `rg`, `fd`, and `relationship_graph`; absent, malformed, or duplicate providers fail closed and those tools remain unavailable. `search_excerpt` stays Scout-specific: it returns deterministic line-numbered matching excerpts plus bounded context, tries `rg` then `grep`, and accepts workspace-relative `path`, `pattern`, optional `glob`, and up to three context lines. Child extension output is capped at 24 KiB and explicitly reports omissions; oversized cited excerpt results are sampled deterministically across files instead of keeping only the head. The child has no shell, mutation tools, unrelated extensions, skills, or context files. There is no hard child turn cap. Activity history retains at most 100 events. Timeouts fail nonfatally; retry with a focused follow-up task.

## Web Scout

Pi receives `web_scout(task, startUrls?, maxPages?)` for current public-web research requiring rendered pages. Every call requires fresh interactive confirmation naming browser limits, selected model, starting hosts, provider exposure, and public-site network exposure.

Web Scout launches a headless temporary Helios-owned browser with no user cookies, tabs, profiles, or logins. A separate child Pi receives only `scout_browser` with `navigate`, `snapshot`, `follow`, and `back`. It cannot attach to user browsers, click arbitrary controls, fill forms, execute model-supplied scripts, access storage through tools, upload, download, or capture screenshots. Public pages may execute their own JavaScript and use temporary isolated cookies/storage; all are discarded when browser closes. Browser and child session close after each call.

All browser traffic passes through an authenticated loopback proxy. Each HTTP request and HTTPS tunnel resolves every destination, rejects mixed or non-public DNS answers, connects directly to the validated address, and permits only ports 80/443. Loopback, private, link-local, carrier-grade NAT, multicast, documentation, transition, reserved, and metadata ranges are blocked for explicit navigation, redirects, and subresources. QUIC, non-proxied WebRTC, service workers, downloads, and proxy loopback bypass are disabled.

Default navigation budget is 8; accepted range is 1–12. Redirects and subresources share bounded proxy request/byte budgets but are not counted as separate tool navigations. Calls also have a bounded action budget and five-minute timeout. Reports cite URLs, titles, access date, short supporting excerpts, and gaps. Web pages remain untrusted data.

## Session Search

Only original user input beginning with `Search my Pi session ...` or `Search my Pi sessions ...` triggers search. The package scans at most 200 newest sessions, selects at most 12 user or assistant text excerpts, redacts likely credentials, caps evidence, and gives it to a tool-free child. Evidence and findings stay transient; the current session stores metadata only.

## Privacy and Cost

Every child call costs the selected model's rates. Cache savings are never assumed. Repository Scout sends its task to the selected provider; only retryReason follow-ups also send bounded recent parent context. Web Scout sends its task and returned public-page text, while visited sites receive browser traffic, network address, and any research terms used in navigation; it never receives parent-session context. Session search can send text from other workspaces. Redaction is defense in depth, not proof of secrecy.

Repository and Web Scout have a $0.50 reported-cost discovery ceiling per call by default. Set `PI_SCOUT_MAX_COST_USD` to a positive finite USD amount to override it, or `0` to disable the ceiling. When a tool-use response reaches the ceiling, Scout is steered once to return its compact cited findings; that one final report response may raise the total beyond the ceiling. There are no checkpoints. This relies on model-reported usage cost and does not guarantee actual provider billing.

Repository timeout is 15 minutes by default. Set `PI_SCOUT_TIMEOUT_MS` to `1..7200000` milliseconds to override it. Session-search timeout remains 90 seconds. Failures are nonfatal. Pi extensions run with full user permissions; review source before installation.
