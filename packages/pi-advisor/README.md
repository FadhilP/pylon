# pi-advisor

Tool-free strategic model consultation for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-advisor. Run `/reload` after installation.

## Configuration

Run `/advisor` in TUI or `/advisor provider/model-id[:thinking]` in any mode. Example: `/advisor anthropic/claude-sonnet-4-5:high`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, the provider default applies. Advisor stays inactive until selection or `/advisor reset`.

- `/advisor status` reports model, thinking level, and state.
- `/advisor disable` disables consultations.
- `/advisor reset` enables Advisor using the current main model and thinking level.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

Selecting or resetting to a model consents to sending that model and provider a redacted, bounded snapshot of the current Pi conversation. Explicit non-TUI commands and manually edited config also count as consent.

## Usage

The executor may complete at most three authenticated `advisor({ request, evidence?: [{ path, start, end }] })` consultations per original prompt. Unavailable model or credential checks do not consume quota.

Use the first call after focused reads or Scout establish evidence, before a consequential non-local decision. Use a second when implementation, competing evidence, or review changes that decision. Reserve the third for material new evidence, contradictions, or test failures that leave the decision unresolved. Skip trivial edits and short Q&A.

Evidence is limited to five workspace-relative regular text files, 200 lines per range, 400 lines and 32 KiB total. `.git`, traversal, binary files, and files over 1 MiB are rejected nonfatally. Scout gathers evidence; the main model makes the initial and final judgments. Advisor has no tools and cannot inspect or mutate files.

## Context and Limits

Input priority is the executor request, explicit workspace evidence, pi-continuity state, latest bounded Verify metadata, compaction or branch summaries, latest user request, latest non-empty assistant text, then system instructions. Raw tool and shell results are excluded. Advisor requests use an estimated 2,048-token cap; latest user requests use head-and-tail retention under an estimated 4,096-token cap.

Calls use context-window-aware budgets with an estimated 32,768-token total input cap. Output is capped at an estimated 8,192 tokens. Calls time out after 15 minutes and fail nonfatally.

## Security and Cost

Every call costs the selected model's rates. UI reports provider usage, cache reads and writes, and total cost. Long cache retention follows `PI_CACHE_RETENTION=long`; savings are never assumed.

Snapshot redaction is defense in depth, not proof of secrecy. The package stores only model choice; snapshots remain in memory and never enter tool details. Advice persists as a normal tool result. Pi packages run with full user permissions; review source before installation.
