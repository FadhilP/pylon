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

Pi Sieve is enabled by default. Its global mode and telemetry reset with each runtime. The configured threshold and active-pruning decision persist across restarts in `<agent-dir>/pi-sieve/config.json`. `observe` performs the same classification as `enable`, but does not change outbound context. `disable` neither classifies nor changes context. Thresholds are integer JavaScript-character counts from 1,000 through 50,000; the default is 8,192.

Active-result pruning defaults on. `/sieve active enable` and `/sieve active disable` save that decision for future runtimes. In global `enabled` mode, eligible text-only age-0 results strictly over the configured threshold are capped to that threshold including recovery metadata. Plain successful output retains balanced head and tail text; errors retain tail text. Ranked `symbol_search` and `code_search` output instead retains complete highest-ranked result objects and valid JSON. `relationship_graph` is preserved at ages 0 and 1 because pi-discover already bounds it structurally. Eligible plain source tools are `bash`, `grep`, `find`, `ls`, `rg`, and `fd`; `read` and `index_status` remain excluded.

The full original remains in the stored session. Active plain-tool recall exposes omitted text; active ranked-search recall exposes the complete original structured result. Both use `sieve_recall`, keyed by the exact `toolCallId` shown in the marker or structured recovery metadata. Multiple source text blocks are treated as one concatenated text stream. Results without a unique non-empty tool-call ID, whose recovery marker leaves no retained payload, or whose expected structured JSON is malformed fail open and remain unchanged. Recalled output remains visible at age 0, then follows the original source tool's normal policy. Failed or malformed recalls and recalls of ineligible source tools remain unchanged. The recall tool is active only when both active-result pruning and global `enabled` mode are active. Reloading clears its in-memory current-turn recovery index, not the saved setting.

`/sieve threshold <value>` and `/sieve threshold reset` also persist. `status` reports the latest call and cumulative telemetry: scanned results, actual or observe-projected transformations (including age-threshold, budget, giant-error, and active-threshold classifications), estimated gross and net tokens saved, each skip reason, and active recall volume. Token estimates use four JavaScript characters per token; exact provider tokenization varies. `reset-stats` clears only telemetry; it preserves mode and saved settings.

Pi Sieve creates an outbound context view; it never modifies stored session messages.

## Policy

Plain `bash`, `grep`, `find`, `ls`, `rg`, and `fd` results plus structured `symbol_search`, `code_search`, and `relationship_graph` results are eligible; `read` and `index_status` results are never changed. Results must contain only text blocks. Their age is the number of user messages after the result. With active-result pruning disabled, age 0 is preserved. With active-result pruning enabled by default, oversized plain and ranked-search age-0 results are partially retained with recall metadata. `relationship_graph` remains intact through age 1. For other successful results, age 1 uses the configured threshold when active pruning is enabled or three times that threshold when disabled. At ages 2–5 the configured threshold applies, and at age 6+ it is halved (minimum 1,000 characters). Equality is retained except that relationship graphs become marker-only at age 6.

Eligible successful output at ages 2+ shares a retained-source budget of three times the configured threshold. It is evaluated newest-to-oldest. Plain results retain balanced head and tail text when partially kept. Ranked searches retain complete highest-ranked result objects. Relationship graphs retain complete location nodes and their corresponding file/query nodes and edges. Structured replacements remain valid JSON and report omitted result or location counts. Once no useful retained-source budget remains, older results use marker-only output. Marker overhead is outside the plain retained-source budget. Any replacement that would be as large as its source fails open. Age-1 output remains outside the cumulative budget.

Old eligible text-only errors remain intact except giant errors strictly over `max(32,000, 4 × threshold)` characters. Those are replaced by a compact error marker followed by the final 2,048 source characters. Errors do not consume the successful-output budget. Non-text, malformed, mixed-content, and empty errors stay unchanged.

Without active-result pruning, age 0 is preserved and fewer than two user messages means nothing is transformed. Active-result pruning can operate on the first user turn. Tool results are never deleted, stored messages stay untouched, and all non-content message fields remain intact.
