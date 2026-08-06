# pi-sieve

Cache-stable outbound tool-result projections for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

Run `/reload` after installation.

## Usage

```text
/sieve status
/sieve enable
/sieve observe
/sieve disable
/sieve projection standard
/sieve projection standard-v2
/sieve projection stable
/sieve reflow
/sieve rollover 8 4
/sieve rollover reset
/sieve active enable
/sieve active disable
/sieve threshold 12000
/sieve threshold reset
/sieve reset-stats
```

Pi Sieve is enabled in Standard V2 (`standard`) projection mode by default. The threshold, active-pruning setting, projection mode, and rollover multipliers persist in `<agent-dir>/pi-sieve/config.json`. Thresholds are integer JavaScript-character counts from 1,000 through 50,000; the default is 8,192. Stable rollover defaults to a high watermark of `8T` and a newest-first target of `4T`, where `T` is the configured threshold. Multipliers are integers from 1 through 64 and the high value must exceed the target.

`observe` computes projections and telemetry without changing outbound context. `disable` does neither. Moving between runtime modes starts a fresh projection epoch before the next provider call.

## Standard V2 (default)

`/sieve projection standard` or `/sieve projection standard-v2` selects the cache-friendlier default policy while preserving the compact shared `3T` old-result budget:

- age-0 and age-1 active projections are byte-identical and remain recallable while their raw source is available
- age-2+ results keep the configured threshold instead of halving at age 6
- shared-budget boundaries use fixed full, half, or marker tiers instead of arbitrary reslicing
- telemetry compares consecutive outbound projections and attributes prefix churn to active threshold, age threshold, budget, stale read, duplicate, error cap, or unrelated history

`/sieve projection legacy` selects the previous Standard V1 policy for compatibility. Switching projection mode starts a new epoch and resets the provider prefix once.

## Stable projections (experimental)

Stable mode freezes every unique tool result the first time it appears in an epoch:

1. Pi Sieve identifies the raw result and its matching call.
2. It applies eligible per-result caps or later-only exact deduplication once.
3. It stores a deep-cloned complete outbound result in an extension-owned ledger.
4. Later context hooks reuse that frozen result byte-for-byte.

New results append context without changing older projections inside the epoch. When reducible retained source strictly exceeds the configured high watermark, Pi Sieve deliberately starts one `budget-rollover` epoch, recomputes unique eligible successful results newest-to-oldest toward the lower target, and freezes that new ledger. This trades one explicit cache reset for another stable period. Protected, unsupported, erroneous, missing-ID, and duplicate-ID results remain outside the rollover budget. Pi's normal compaction remains responsible for context that Sieve cannot reduce.

Raw session messages are never transformed or persisted by Pi Sieve.

### Continuity retained-suffix projection

When the active branch's latest compaction is Continuity v3, Sieve also projects its retained historical suffix after the selected baseline policy. It freezes that compaction's tool-call IDs (from `firstKeptEntryId` through the compaction parent), leaves all assistant blocks unchanged, and keeps the newest completed historical tool-call batch complete. Older, unique, successful text-only pairs for normal Sieve-eligible tools and `read` may become smaller `sieve_recall` markers. Errors, mixed/image content, mutations, unsupported tools, duplicate or uncertain IDs, and post-compaction calls remain unchanged. A later non-Continuity compaction disables this projection. The boundary is reconstructed from the active branch after reload; no Sieve summary or digest is persisted.

### Epochs

A new epoch deliberately resets the provider prefix after:

- session start, reload, or session replacement
- compaction
- branch/tree navigation
- model or provider change
- effective system-prompt or active tool-schema change
- threshold, active-pruning, projection-mode, or runtime-mode change
- explicit `/sieve reflow`
- automatic retained-source budget rollover
- detected non-append history or source-identity mismatch

User messages, assistant turns, new results, repeated context hooks, and recall calls do not start epochs.

Reload and branch reconstruction use the raw compaction-aware context supplied by Pi. Results are replayed in source order, so projections depend only on the candidate and earlier raw history. The projection policy is versioned in the epoch fingerprint.

### One-time policy

With active pruning enabled, each newly observed eligible result is independently capped:

- plain successful text retains balanced head and tail text
- recent errors use a conservative minimum 8,192-character cap
- ranked `symbol_search` and `code_search` output retains complete highest-ranked records and valid JSON
- `relationship_graph` retains complete grouped records and valid JSON
- mixed content slices only text blocks; image and unknown blocks remain in order

Eligible plain tools are `bash`, `grep`, `find`, `ls`, `rg`, `fd`, and `heartbeat_status`, plus Memory list results. Mutation/control results, unique `read` results, unique `advisor`, `repo_scout`, and `grunt` evidence, and Verify failures remain intact.

A later successful read is replaced only when normalized path, computed range, and ordered content exactly match an earlier read and no same-path edit/write intervened. Generic successful results are deduplicated only when tool name, structural arguments, details, and ordered content match exactly. Originals never change. Failures and mutation/control tools are not generically deduplicated.

Missing or duplicate result IDs fail open. If an ID becomes ambiguous, its already-frozen original remains unchanged, the ambiguous occurrence passes through, and ID-only recall is disabled. Unexpected historical/source changes force one explicit new epoch rather than incrementally rewriting history.

## Recall

Recoverable markers include an exact `toolCallId` for `sieve_recall`. Recall:

1. requires an ID registered by the current frozen ledger,
2. requires one unique matching result in the latest raw active context,
3. validates tool name, error state, and frozen source identity,
4. returns a deep clone of every original ordered content block.

Missing, stale, ambiguous, or mismatched IDs fail closed. A successful recall is a newly appended explicit recovery and remains complete for the rest of the epoch. The recall tool is active only when active pruning and global `enabled` mode are both active.

## Standard projection

`/sieve projection standard` and `/sieve projection standard-v2` use the default cache-friendlier mutable age/budget implementation described above. `/sieve projection legacy` retains Standard V1 compatibility. Standard mode may still reslice prior results as they age. Switching projection mode starts a new epoch and reports that the cached prefix will reset.

Use `/sieve projection stable` to try the experimental immutable projections and automatic rollover.

## Telemetry

`/sieve status`, `pi-sieve:state-change`, and the web Inspector expose:

- epoch ID, reason, start time, and prompt fingerprint
- frozen result, source-character, retained-character, and recoverable counts
- new projections and projection-ledger cache hits
- explicit reflows, automatic budget rollovers, and watermark crossings
- prefix-churn violations, earliest changed index, and estimated invalidated characters
- current context usage percentage when Pi reports it
- per-tool transformations, retained characters, and savings
- recall totals and restored characters

Cumulative transformation totals, recall totals, per-tool recall totals, and stability counters are stored as compact custom entries on the active session branch. They survive reload/resume, follow branch navigation, and `/sieve reset-stats` persists a zero snapshot. Latest-call stats, epoch ledgers, and current gauges remain runtime state.

Recall payload caches are not duplicated in telemetry entries. Pi Sieve rebuilds them from the active raw session context before each model call; compaction can make a historical source unavailable even though its recall totals remain recorded.

The critical stable-mode invariant is `prefix-churn violations: 0`. Provider-reported input and cache-read usage remains authoritative; Pi Sieve does not attribute provider usage to individual tools.

Pi Sieve does not trigger automatic compaction. Rollover controls reducible retained tool source only; context usage and unprunable content remain operational signals.
