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

`status` reports the latest call and cumulative telemetry: scanned old results, actual or observe-projected transformations, estimated gross and net tokens saved, and each skip reason. Token estimates use four JavaScript characters per token; exact provider tokenization varies. `reset-stats` clears only that telemetry; it preserves the mode and threshold.

Pi Sieve creates an outbound context view; it never modifies stored session messages.

## Policy

Only successful old `bash`, `grep`, `find`, `ls`, `rg`, and `fd` tool results are considered. Results from `read` are never changed. A result must contain only text blocks totaling more than the configured threshold. Eligible output is replaced by one marker that names pi-sieve and reports the source character count; all other message fields remain intact.

Everything from the second-latest user message onward is preserved. If there are fewer than two user messages, nothing is transformed. Tool results are never deleted, including errors and non-text, malformed, mixed-content, or empty-content results.
