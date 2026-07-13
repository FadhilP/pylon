# pi-advisor

Tool-free strategic model consultation for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-advisor. Run `/reload` after installation.

## Configuration

Run `/advisor` in TUI or `/advisor provider/model-id[:thinking]` in any mode. Example: `/advisor anthropic/claude-sonnet-4-5:high`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, the provider default applies. No model default exists; the tool stays inactive until selection.

- `/advisor status` reports model, thinking level, and state.
- `/advisor disable` disables consultations.
- `/advisor reset` remains an alias for disable.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

Selecting a model consents to sending that model and provider a redacted, bounded snapshot of the current Pi conversation. Explicit non-TUI commands and manually edited config also count as consent.

## Usage

The executor may complete at most three authenticated `advisor({ request, evidence?: [{ path, start, end }] })` consultations per original prompt. Unavailable model or credential checks do not consume quota.

Use the first call after focused reads or Scout establish evidence, before a consequential non-local decision. Use a second when implementation, competing evidence, or review changes that decision. Reserve the third for material new evidence, contradictions, or test failures that leave the decision unresolved. Skip trivial edits and short Q&A.

Evidence is limited to five workspace-relative regular text files, 200 lines per range, 400 lines and 32 KiB total. `.git`, traversal, binary files, and files over 1 MiB are rejected nonfatally. Scout gathers evidence; the main model makes the initial and final judgments. Advisor has no tools and cannot inspect or mutate files.

## Context and Limits

Input priority is the executor request, explicit workspace evidence, pi-continuity state, latest bounded Verify metadata, compaction or branch summaries, latest user request, latest non-empty assistant text, then system instructions. Raw tool and shell results are excluded. Latest user request uses head-and-tail retention under an estimated 8k-token cap.

Calls use context-window-aware budgets with an estimated 32k-token total input cap. Output is capped at 8k tokens. Calls time out after 15 minutes and fail nonfatally.

## Security and Cost

Every call costs the selected model's rates. UI reports provider usage, cache reads and writes, and total cost. Long cache retention follows `PI_CACHE_RETENTION=long`; savings are never assumed.

Snapshot redaction is defense in depth, not proof of secrecy. The package stores only model choice; snapshots remain in memory and never enter tool details. Advice persists as a normal tool result. Pi packages run with full user permissions; review source before installation.
