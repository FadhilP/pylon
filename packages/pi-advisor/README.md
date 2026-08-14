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

### Consultation Timing

The executor may make at most three authenticated `advisor({ request, evidence?: [{ path, start, end, claim?, revision?, verification? }] })` attempts per original prompt. Unavailable model or credential checks do not consume quota.

Use one consultation before implementation only when both conditions hold: multiple credible approaches have meaningful tradeoffs and repository precedent does not clearly determine the solution; and a wrong choice risks security or privacy, data loss, compatibility or migration failure, or broad cross-module regression. Call it after focused reads or Scout establish evidence, before choosing an approach. Consult again after implementation only when implementation exposes new risks, contradicts assumptions, or verification fails ambiguously—not by default. Reserve the third for material contradictions, failures, or unresolved risks. Skip local fixes, established repository patterns, routine refactors, test additions, dependency-free changes, and decisions reversible in one small diff.

### Evidence

Evidence is limited to eight regular text ranges inside the workspace and 200 lines per range. Paths may be workspace-relative or canonical absolute workspace paths; traversal, out-of-workspace targets, symlink escapes, `.git`, binary files, and files over 1 MiB are rejected nonfatally. Usually provide 3–5 concise, non-overlapping ranges; use up to eight only when each range is independently necessary, and avoid redundant evidence. Prefer complete decisive definitions, callers, and checks over broad file slices; 150–300 total lines is a selection signal, not a hard cap. Exceed it when correctness requires more context. Scout gathers evidence; the main model makes the initial and final judgments. Advisor has no tools and cannot inspect or mutate files.

## Context, Limits, and Cost

### Context Packing

Input priority is the executor request, relevance-ranked explicit workspace evidence, pi-continuity state, latest bounded Verify metadata, compaction or branch summaries, latest user request, then latest non-empty assistant text. Raw tool and shell results and the executor's full system prompt are excluded. The Advisor receives a separate minimal system contract preserving its tool-free review role, evidence skepticism, security boundaries, and executor authority. Snapshot records are never clipped: complete prioritized records are packed under the global input budget, while records that do not fit are omitted with bounded path/range references for focused retrieval. A required Advisor request fails nonfatally instead of being clipped when it cannot fit.

### Budgets

Calls use context-window-aware budgets with an estimated 32,768-token total input cap. Output is capped at an estimated 8,192 tokens and may be lowered by the cost preflight. Calls time out after 15 minutes and fail nonfatally.

## Cost, Security, and Privacy

### Cost

Every call costs the selected model's rates. Advisor applies a $0.50 estimated-cost ceiling per call: model pricing and estimated uncached input cost determine the maximum output tokens, and calls fail nonfatally when estimated input alone exhausts the budget. Provider tokenization, retries, and reported pricing can differ, so this limits estimated cost rather than guaranteeing final billing. UI reports provider usage, cache reads and writes, and total cost. Long cache retention follows `PI_CACHE_RETENTION=long`; savings are never assumed.

### Data Handling

Snapshot redaction is defense in depth, not proof of secrecy. The package stores only model choice; snapshots remain in memory and never enter tool details. Advice persists as a normal tool result. Pi packages run with full user permissions; review source before installation.
