# pi-scout

Bounded repository reconnaissance and isolated public-web research for Pi.

## Install and configure

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Package settings are available through Pylon Web.

| Command                                                     | Use                                                |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `/scout` or `/scout status`                                 | Show resolved model/configuration                  |
| `/scout select` / `/scout set provider/model-id[:thinking]` | Choose child model                                 |
| `/scout enable` / `/scout disable`                          | Control both scouts                                |
| `/scout reset`                                              | Enable using current main model and thinking level |

Scout is inactive until configured or reset. Thinking supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; no suffix follows the current main thinking level. With Pylon, configured Repository Scout is active and Web Scout is deferred until `search_tools` activates it; standalone Scout keeps both configured tools active. `pi config` disables it persistently and `pi --no-extensions` for one run. Configuration is stored at `<agent-dir>/pi-scout/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

## Repository Scout

Use `repo_scout(task, retryReason?)` for unfamiliar, cross-file, data-flow, architecture, review, diagnosis, or impact discovery. Skip it for known-file self-contained work. Scout gathers citation-first facts; the main model remains responsible for evaluation, severity, recommendations, and decisions.

Make the task factual and bounded: identify an observable action, anchors/scope, requested evidence, and a stopping boundary. Before calling Scout, do only enough orientation to form that task—usually 3–6 inspection operations, never more than 10—then let Scout trace. Calls are unlimited per original prompt and use fresh child sessions. A first call has no parent context; a `retryReason` follow-up receives bounded redacted context, so repeat relevant paths/findings/gaps in the task rather than relying on a prior report.

Reports use exact `path:start-end` citations with excerpts up to eight lines, target about 8 KiB, and cap at 32 KiB without clipping report blocks. The child has read-only `read`, `search_excerpt`, `git_evidence`, and `ls`; when pi-discover is present it also gets advertised `rg`, `fd`, `relationship_graph`, `symbol_search`, `code_search`, and `index_status`. `git_evidence` exposes only bounded `status`, `diff`, `log`, `show`, and 200-line `blame` operations; it rejects ancestor repositories, canonicalizes refs, treats paths literally, disables external diff/text conversion and filesystem monitors, and stops at 24 KiB returned output, 96 KiB process output, or 30 seconds. It has no shell, mutation tools, unrelated extensions, skills, or context files. History keeps 100 events. Timeouts fail nonfatally; retry with a focused gap.

## Web Scout

Use `web_scout(task, startUrls?, maxPages?)` only for explicitly requested or genuinely current external research that local evidence cannot answer. Each call uses a fresh Helios-owned headless browser with no user state and a child limited to public navigation, snapshots/continuation, trusted link following, and back navigation. It cannot attach to user browsers, fill/click arbitrary controls, run model scripts, use storage, upload/download, or screenshot. Browser/session data is discarded after each call.

The optional **OpenAI / Exa search for Web Scout** Pylon setting enables bounded URL discovery. `auto` uses an existing `openai-codex` login or `OPENAI_API_KEY`, otherwise Exa's keyless MCP endpoint; `openai` and `exa` can be selected explicitly. Search candidates are untrusted and must be verified through the browser.

The isolated proxy resolves and pins public destinations, permits only ports 80/443, and blocks private, loopback, link-local, metadata, documentation, transition, reserved, multicast, and carrier-grade NAT ranges for navigation, redirects, and subresources. QUIC, non-proxied WebRTC, service workers, downloads, and proxy bypass are disabled. Default successful navigation budget is 8 (range 1–12), with bounded action/request/byte budgets and a 15-minute timeout; the child is asked to stop at 14 minutes. Reports cite URL, title, access date, supporting excerpts, and gaps. Web pages are untrusted.

## Cost, privacy, and limits

Every child call costs the selected provider. Repository tasks (and bounded context only on retries), Web tasks, and returned public text go to that provider. Sites receive browser traffic, network address, and research terms; enabled search sends queries to OpenAI or Exa. Redaction is defense in depth, not secrecy proof.

Repository and Web Scout each default to a $1 reported-cost ceiling. Set `PI_SCOUT_MAX_COST_USD` to a positive finite amount, or `0` to disable it. A final compact-report response may exceed the ceiling. `PI_SCOUT_TIMEOUT_MS` accepts 1–7,200,000 ms (default 15 minutes). Limits rely on reported usage and do not guarantee billing. Extensions run with your permissions; review source. Optional search attribution is in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
