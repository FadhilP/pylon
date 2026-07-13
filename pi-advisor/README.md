# pi-advisor

Tool-free strategic model consultation for [Pi](https://pi.dev).

## Install and select model

```sh
pi install /absolute/path/to/pi-advisor
```

Run `/advisor` in TUI or `/advisor provider/model-id[:thinking]` in any mode. Example: `/advisor anthropic/claude-sonnet-4-5:high`. Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Without suffix, provider default applies. No model default exists; tool stays inactive until selection. `/advisor disable` disables it; `/advisor reset` remains an alias. `/advisor status` reports model, thinking, and state.

Disable whole extension through `pi config`. Disable all extensions for one run with `pi --no-extensions`.

Selecting model consents to sending that model/provider a redacted bounded snapshot of current Pi conversation. Input is prioritized as explicit workspace evidence, pi-continuity state, latest bounded Verify metadata, compaction/branch summaries, latest user request, latest non-empty assistant text, then system instructions. Raw tool and bash results are excluded. Latest user request is capped at an estimated 8k tokens using head-and-tail retention. Explicit non-TUI command and manually edited config also count as consent.

## Use

Executor may complete at most three authenticated `advisor({ evidence?: [{ path, start, end }] })` consultations per original prompt; unavailable model or credential checks do not consume quota. Use first call after focused reads or Scout establish evidence, before a consequential non-local decision. Use second when implementation, competing evidence, or review changes that decision; do not wait for completion. Reserve third for material new evidence, contradictions, or test/failure results that leave it unresolved. Pass only highest-priority cited ranges. Evidence is limited to five workspace-relative regular text files, 200 lines per range, 400 lines and 32 KiB total; `.git`, traversal, binary files, and files over 1 MiB are rejected nonfatally. Scout gathers evidence, main model makes initial judgment, Advisor challenges evidence and reasoning, then main model makes final decision. Advisor invocation and result appear in TUI tool row; expand it to inspect full advice. Skip trivial edits and short Q&A. Advisor has no tools and cannot inspect or mutate files; executor verifies all advice.

## Security and cost

Every call costs selected model rates. UI reports provider usage, cache reads/writes, and total cost. Long cache retention follows `PI_CACHE_RETENTION=long`; savings are never assumed. Snapshot redaction is defense in depth, not proof of secrecy. Package stores only model choice; snapshot remains in memory and never enters tool details. Advice itself persists as normal tool result.

Calls use context-window-aware input/output budgets with an estimated 32k-token total input cap, including advisor instructions and reused prior guidance. Advisor output is capped at 8k tokens. They time out after 15 minutes and fail nonfatally. Pi packages run with full user permissions; review source before install.
