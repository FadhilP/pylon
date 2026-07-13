# pi-scout

Bounded read-only repository scout plus explicit Pi-session search for [Pi](https://pi.dev).

## Install

```sh
pi install /absolute/path/to/pi-scout
```

Select optional child model with `/scout provider/model-id[:thinking]` or just `/scout`; example: `/scout openai/gpt-5:medium`. Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Without suffix, Scout follows current main thinking level. `/scout disable` disables repository and session scouts. `/scout reset` re-enables both using current main model/thinking.

## Repository scout

Pi receives `repo_scout(task, retryReason?)`. Main model should call it before edits for non-local discovery, architecture/data-flow mapping, or cross-file impact. Scout gathers evidence; main model owns evaluation, severity, exploitability, priority, architecture choices, and final conclusions. Broad goals must become observable search criteria. Bad: `find critical vulnerabilities`. Better: `locate authentication and authorization boundaries; trace user-controlled input reaching SQL, shell, filesystem, network, deserialization, and secret-handling operations; cite missing checks and gaps`. Calls are unlimited within one original user prompt; later calls reuse the first child session when possible, with `retryReason` available for gap context. Each call also receives a redacted, bounded handoff from recent parent user/assistant context and tool intent, so `task` need not restate the whole conversation; explicit `task` remains authoritative. Bounded parent handoff also includes log-free Verify results and Timeline checkpoint metadata, enabling failure reconnaissance and change archaeology without granting child mutation access. Scout returns exact `path:start-end` citations plus narrow excerpts. Main model treats those ranges as its working set, reads only cited ranges when source verification is needed, and expands only for a stated gap or changed surrounding context. Known-file micro-edits should skip Scout. Child session runs isolated with read-only `read`, `rg`, `fd`, `grep`, `find`, and `ls`; `rg`/`fd` are bounded external-command wrappers with workspace path checks and automatic guidance to use built-in `grep`/`find` when unavailable. No shell, mutation tools, other extensions, skills, or context files are available. Child tool calls and bounded result previews stream into parent TUI only; activity history retains at most 100 events and raw activity is not returned as main-model context. Child periodically saves a compact cited checkpoint through a dedicated extension-controlled tool with no arbitrary write access. Successful runs return the final report. A timeout returns only the latest checkpoint, marked incomplete, so main model can inspect stated gaps without repeating completed discovery. Expand final Scout tool row to inspect activity and report.

## Session search

Only original user input beginning with `Search my Pi session ...` or `Search my Pi sessions ...` triggers search. Package scans at most 200 newest sessions, selects at most 12 user/assistant text excerpts, redacts likely credentials, caps evidence, and gives it to a tool-free child. Evidence/findings stay transient; current session stores metadata only.

## Privacy and cost

Every child call costs selected model rates. Cache savings are not assumed. Repository Scout sends its explicit task plus bounded recent parent conversation/tool-intent context to selected provider. Session search can send text from other workspaces to selected provider. Redaction is defense in depth, not proof of secrecy. Review source; avoid session search on accounts containing conversations current provider must not see. Extensions run with full user permissions.

Repository calls have no per-prompt quota. Repository timeout: 15 minutes by default; override with `1..7200000` milliseconds in `PI_SCOUT_TIMEOUT_MS`. Session-search timeout remains 90 seconds. Failures remain nonfatal. Disable extension through `pi config`. Disable all extensions for one run with `pi --no-extensions`.
