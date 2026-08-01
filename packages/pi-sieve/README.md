# pi-sieve

Outbound bulky tool-output limiting for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-sieve. Run `/reload` after installation.

## Usage

```text
/sieve status
/sieve disable
/sieve enable
/sieve observe
/sieve active enable
/sieve active disable
/sieve threshold 12000
/sieve threshold reset
/sieve reset-stats
```

### Modes and Settings

Pi Sieve is enabled by default. Its global mode and telemetry reset with each runtime. The configured threshold and active-pruning decision persist across restarts in `<agent-dir>/pi-sieve/config.json`. `observe` performs the same classification as `enable`, but does not change outbound context. `disable` neither classifies nor changes context. Thresholds are integer JavaScript-character counts from 1,000 through 50,000; the default is 8,192.

### Active-Result Pruning

Active-result pruning defaults on. `/sieve active enable` and `/sieve active disable` save that decision for future runtimes. In global `enabled` mode, eligible age-0 and age-1 results share a retained-source budget of three times the configured threshold and each result is capped to the threshold. Plain successful output retains balanced head and tail text; recent errors use a conservative minimum 8,192-character cap. Ranked `symbol_search` and `code_search` output retains complete highest-ranked result objects and valid JSON. `relationship_graph` remains intact through age 1 because pi-discover already bounds it structurally. Eligible plain source tools are `bash`, `grep`, `find`, `ls`, `rg`, `fd`, and `heartbeat_status`, plus `memory` list results. Short Heartbeat start/cancel results, Continuity updates, Memory mutations, unique `read` results, and `index_status` remain excluded from size- and age-based pruning. In mixed-content eligible results, only text blocks are sliced; image and unknown blocks remain unchanged and in order.

### Recall

The full original remains in the stored session. `sieve_recall`, keyed by the exact `toolCallId` shown in a text marker or structured recovery metadata, restores the complete original result from the current session branch, including mixed content. Recovery registrations survive later user inputs and reset at session boundaries; absent, ambiguous, or unregistered IDs fail closed. Results without a unique non-empty tool-call ID, whose recovery marker leaves no retained payload, or whose expected structured JSON is malformed fail open and remain unchanged. Recalled output remains visible at age 0, then follows the original source tool's normal policy. The recall tool is active only when both active-result pruning and global `enabled` mode are active.

### Telemetry

`/sieve threshold <value>` and `/sieve threshold reset` also persist. `status` reports latest and cumulative telemetry, including age-threshold, budget, active-threshold, stale-read, duplicate, error-cap, and mixed-text classifications; per-tool source, retained, and saved characters; skip reasons; and recall volume. Token estimates use four JavaScript characters per token; provider totals remain authoritative. `reset-stats` clears only telemetry; it preserves mode and saved settings.

Pi Sieve creates an outbound context view; it never modifies stored session messages.

## Pruning Policy

### Eligibility and Age

Plain `bash`, `grep`, `find`, `ls`, `rg`, `fd`, and `heartbeat_status` results plus `memory` list results and structured `symbol_search`, `code_search`, and `relationship_graph` results are eligible for size- and age-based pruning. Short Heartbeat start/cancel results, Continuity updates, Memory mutations, unique reads, and `index_status` results are not size/age pruned. Age remains the number of later user messages; model turns do not increment it. With active pruning disabled, age 0 remains preserved and age 1 keeps the prior three-times-threshold policy. With active pruning enabled, eligible age-0/1 output is recoverable and budgeted. At ages 2–5 the configured threshold applies, and at age 6+ it is halved (minimum 1,000 characters). Equality is retained except that relationship graphs become marker-only at age 6.

### Shared Retention Budget

When active pruning is enabled, eligible successful age-0/1 output shares a retained-source budget of three times the threshold. Ages 2+ use the same-size separate budget. Both are evaluated newest-to-oldest. Plain results retain balanced head and tail text; ranked searches retain complete highest-ranked objects; relationship maps retain complete grouped records. Marker overhead is outside the source budget. Once no useful source budget remains, marker-only output is used. Replacements that would be as large as their source fail open.

### Errors

Eligible recent errors over `max(8,192, threshold)` are recoverably capped when active pruning is enabled. At age 2+, errors over the configured threshold retain a compact diagnostic head and tail. Errors do not consume the successful-output budget. Ineligible and protected delegated or verification failures remain unchanged.

### Reads and Exact Duplicates

Unique successful `read` results are never size- or age-pruned. A later successful read is replaced only when its normalized path, computed coverage, and ordered content exactly match an earlier read and no intervening same-path edit/write is present; the original is retained to preserve the prompt-cache prefix. The same later-only rule applies to successful, structurally identical non-mutation tool results with equal tool name, arguments, details, and ordered content. Failures and mutation/control tools are not generically deduplicated.

The existing conservative stale-read policy remains: an earlier read is replaced only after a successful same-path edit/write and a still-later covering read. Whole-file rereads qualify; partial rereads require line-preserving intervening edits and full range coverage. Same-message calls, failed or ambiguous mutations, mixed image reads, malformed ranges, and reads without a covering snapshot are preserved. Shell mutations are not inferred.

Without active-result pruning, age 0 is preserved for size-based pruning and fewer than two user messages means no age-based output is transformed. Stale-read pruning can operate on the first user turn when its full read-mutate-reread sequence is present. Active-result pruning can also operate on the first user turn. Tool results are never deleted, stored messages stay untouched, and all non-content message fields remain intact.
