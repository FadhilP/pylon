# pi-advisor

A tool-free second opinion for consequential Pi decisions. Advisor reviews a bounded, redacted conversation snapshot; it cannot inspect or change your files.

## Install and configure

Requires Pi and Node 22.19.0 or later. Install the Pylon bundle, then reload Pi:

```sh
pi install git:github.com/FadhilP/pylon
```

| Command | Use |
| --- | --- |
| `/advisor` or `/advisor status` | Show configuration |
| `/advisor select` | Choose a model in the TUI |
| `/advisor set provider/model-id[:thinking]` | Set a model, for example `anthropic/claude-sonnet-4-5:high` |
| `/advisor disable` / `/advisor reset` | Disable, or enable with the current main model and thinking level |
| `/advisor help` | Show usage |

Thinking may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; no suffix uses the provider default. Advisor is inactive until selected or reset. `pi config` disables the extension persistently; `pi --no-extensions` disables it for one run. Its package settings are also available through Pylon Web.

Selecting or resetting a model consents to sending the selected provider a redacted, bounded conversation snapshot. Explicit non-TUI commands and manually edited configuration also count as consent.

## Using Advisor well

Call `advisor({ request, evidence? })` before choosing an implementation only when credible approaches have meaningful tradeoffs, repository precedent is insufficient, and a wrong choice risks security/privacy, data loss, compatibility/migration failure, or broad regression. Supply focused evidence after initial reads or Scout work. Reconsult only for material new risk, contradicted assumptions, or ambiguous verification failure. Do not use it for local fixes, established patterns, routine refactors, tests, dependency-free changes, or easily reversible small diffs.

There are at most three authenticated attempts per original user prompt. Unavailable models or credentials do not consume the limit. Evidence accepts at most eight workspace text ranges, each up to 200 lines. Paths must be workspace-relative or canonical workspace paths; traversal, escapes, `.git`, binary files, symlink escapes, and files over 1 MiB are rejected without failing the call. Usually provide 3–5 decisive non-overlapping definitions, callers, or checks.

## Context, cost, and privacy

Advisor prioritizes the request, supplied evidence, Continuity state, bounded Verify metadata, summaries, latest user request, and latest assistant text. It excludes raw shell/tool output and the executor system prompt. Complete records are packed under the budget; records that do not fit are omitted with bounded references rather than clipped. An oversized required request fails nonfatally.

Calls target an estimated 32,768-token input cap, up to 8,192 output tokens, and a 15-minute timeout. A $0.50 estimated per-call ceiling can reduce output or reject input that exhausts the estimate. This is not a billing guarantee: provider tokenization, retries, and pricing differ. Usage UI reports provider usage, cache reads/writes, and cost; long cache retention follows `PI_CACHE_RETENTION=long`.

Configuration is stored at `<agent-dir>/pi-advisor/config.json`; Pylon Web's default agent directory is `~/.pylon/agent`, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden. Snapshots remain in memory and are never put in tool details; advice is retained as a normal Pi tool result. Redaction is defense in depth, not secrecy proof. Pi packages run with your user permissions; review source before installation.