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
/sieve threshold 12000
/sieve threshold reset
/sieve reset-stats
```

Pi Sieve is enabled by default and keeps its mode, threshold, and telemetry only for the current runtime. `observe` performs the same classification as `enable`, but does not change the outbound context. `disable` neither classifies nor changes context. Thresholds are integer JavaScript-character counts from 1,000 through 50,000; the default is 8,000.

`status` reports the latest call and cumulative telemetry: scanned old results, actual or observe-projected transformations (including age-threshold, budget, and giant-error classifications), estimated gross and net tokens saved, and each skip reason. Token estimates use four JavaScript characters per token; exact provider tokenization varies. `reset-stats` clears only that telemetry; it preserves the mode and threshold.

Pi Sieve creates an outbound context view; it never modifies stored session messages.

## Policy

Only `bash`, `grep`, `find`, `ls`, `rg`, and `fd` results are eligible; `read` results are never changed. Successful results must contain only text blocks. Their age is the number of user messages after the result. Age 0 is always preserved. At age 1, output strictly over three times the configured threshold is replaced. At ages 2–5 the configured threshold applies, and at age 6+ it is halved (minimum 1,000 characters). Replacements use a compact marker containing the tool name and source character count; equality is retained.

Eligible successful output that survives its age threshold shares a retained-output budget of three times the configured threshold. It is evaluated newest-to-oldest and retained whole only when it fits the remaining budget; results that do not fit are replaced, never partially retained. Age-threshold replacements do not consume that budget.

Old eligible text-only errors remain intact except giant errors strictly over `max(32,000, 4 × threshold)` characters. Those are replaced by a compact error marker followed by the final 2,000 source characters. Errors do not consume the successful-output budget. Non-text, malformed, mixed-content, and empty errors stay unchanged.

Age 0 is preserved. If there are fewer than two user messages, nothing is transformed. Tool results are never deleted, and all non-content message fields remain intact.
