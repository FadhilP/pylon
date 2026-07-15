# pi-scout

Bounded repository reconnaissance, consent-gated isolated public-web research, and explicit Pi-session search for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-scout. Run `/reload` after installation.

## Configuration

Scout stays inactive until you select a child model with `/scout provider/model-id[:thinking]` or `/scout`, or run `/scout reset` to use the current main model. Example: `/scout openai/gpt-5:medium`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, Scout follows the current main thinking level.

- `/scout disable` disables repository, web, and session scouts.
- `/scout reset` enables all scouts using the current main model and thinking level.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

## Repository Scout

Pi receives `repo_scout(task, retryReason?)`. The main model should call it before edits for non-local discovery, architecture or data-flow mapping, and cross-file impact. Scout gathers evidence; the main model owns evaluation, severity, exploitability, priority, architecture choices, and final conclusions.

Broad goals must become observable search criteria. Bad: `find critical vulnerabilities`. Better: `locate authentication and authorization boundaries; trace user-controlled input reaching SQL, shell, filesystem, network, deserialization, and secret-handling operations; cite missing checks and gaps`.

When Scout is needed but neither the user request nor current context supplies a concrete path, package, symbol, or boundary, the main model first performs a bounded read-only orientation pass with a few targeted `fd`, `rg`, or narrow `read` operations. It stops once enough anchors exist for a concrete Scout task; it does not inventory the repository or duplicate Scout tracing. Existing reliable anchors skip this pass.

Calls are unlimited within one original user prompt. Later calls reuse the first child session when possible; `retryReason` supplies gap context. Before a follow-up, the main model performs one bounded parent-side gap pass with targeted `fd`, `rg`, or narrow `read` over existing anchors when that can cheaply resolve gaps or sharpen the request. It combines related unresolved gaps and search criteria into one coherent follow-up instead of calling Scout once per finding, file, or question. It skips this pass when the prior report already identifies a specific broader trace requiring Scout. The next call starts a fresh child session when the latest child response reports either more than 131,072 non-cache context tokens or more than 524,288 cache-read tokens. The first call in each child session receives a redacted, bounded handoff from recent parent context and tool intent, including log-free Verify and Timeline checkpoint metadata. Continued calls avoid resending that context and must include relevant new constraints or parent-side findings in `task` or `retryReason`.

Scout returns exact `path:start-end` citations and narrow excerpts. The main model treats them as sufficient for read-only evaluation by default. It rereads cited ranges only when an exact edit needs current text, evidence has a stated gap or conflict, or repository state changed; expansion remains limited to those cases. Known-file micro-edits should skip Scout.

The isolated child has read-only `read`, `rg`, `fd`, `grep`, `find`, and `ls`. It has no shell, mutation tools, other extensions, skills, or context files. It batches clearly independent searches or narrow reads while keeping dependent investigation sequential. Activity history retains at most 100 events. Timeouts fail nonfatally; retry with a focused follow-up task.

## Web Scout

Pi receives `web_scout(task, startUrls?, maxPages?)` for current public-web research requiring rendered pages. Every call requires fresh interactive confirmation naming browser limits, selected model, starting hosts, provider exposure, and public-site network exposure.

Web Scout launches a headless temporary Helios-owned browser with no user cookies, tabs, profiles, or logins. A separate child Pi receives only `scout_browser` with `navigate`, `snapshot`, `follow`, and `back`. It cannot attach to user browsers, click arbitrary controls, fill forms, execute model-supplied scripts, access storage through tools, upload, download, or capture screenshots. Public pages may execute their own JavaScript and use temporary isolated cookies/storage; all are discarded when browser closes. Browser and child session close after each call.

All browser traffic passes through an authenticated loopback proxy. Each HTTP request and HTTPS tunnel resolves every destination, rejects mixed or non-public DNS answers, connects directly to the validated address, and permits only ports 80/443. Loopback, private, link-local, carrier-grade NAT, multicast, documentation, transition, reserved, and metadata ranges are blocked for explicit navigation, redirects, and subresources. QUIC, non-proxied WebRTC, service workers, downloads, and proxy loopback bypass are disabled.

Default navigation budget is 8; accepted range is 1–12. Redirects and subresources share bounded proxy request/byte budgets but are not counted as separate tool navigations. Calls also have a bounded action budget and five-minute timeout. Reports cite URLs, titles, access date, short supporting excerpts, and gaps. Web pages remain untrusted data.

## Session Search

Only original user input beginning with `Search my Pi session ...` or `Search my Pi sessions ...` triggers search. The package scans at most 200 newest sessions, selects at most 12 user or assistant text excerpts, redacts likely credentials, caps evidence, and gives it to a tool-free child. Evidence and findings stay transient; the current session stores metadata only.

## Privacy and Cost

Every child call costs the selected model's rates. Cache savings are never assumed. Repository Scout sends its task and bounded recent parent context to the selected provider. Web Scout sends its task and returned public-page text, while visited sites receive browser traffic, network address, and any research terms used in navigation; it never receives parent-session context. Session search can send text from other workspaces. Redaction is defense in depth, not proof of secrecy.

Repository timeout is 15 minutes by default. Set `PI_SCOUT_TIMEOUT_MS` to `1..7200000` milliseconds to override it. Session-search timeout remains 90 seconds. Failures are nonfatal. Pi extensions run with full user permissions; review source before installation.
