# pi-sieve

Outbound projections for bulky Pi tool results that reduce context while keeping eligible source recoverable through `sieve_recall`. It never changes raw session messages.

## Install and controls

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Package settings are available through Pylon Web.

| Command | Use |
| --- | --- |
| `/sieve` / `/sieve status` | Show state and telemetry |
| `/sieve mode enabled|observe|disabled` | Apply projections, observe only, or disable them |
| `/sieve projection standard-v2|stable` | Select default or experimental policy |
| `/sieve reflow` | Start a new projection epoch |
| `/sieve rollover HIGH TARGET` / `reset` | Configure stable-mode watermarks |
| `/sieve active-pruning on|off` | Toggle eligible per-result reduction |
| `/sieve threshold N` / `reset` | Set cap (1,000–50,000 characters) |
| `/sieve reset-stats` | Persist zeroed cumulative stats |

Standard V2 and active pruning are enabled by default. The default threshold is 8,192 JavaScript characters. Configuration is stored at `<agent-dir>/pi-sieve/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden. Stable rollover defaults to high `8T` and target `4T`, where `T` is threshold; multipliers are 1–64 and high must exceed target. Observe computes telemetry without changing provider context; disabled does neither. Changing modes starts a fresh epoch.

## Projection and recall

Standard V2 keeps the shared `3T` old-result budget, makes age-0/age-1 projections identical and recallable, keeps age-2+ at the configured threshold, and uses fixed budget tiers to reduce prefix churn. It may reslice old results as they age.

Experimental `stable` freezes each eligible unique result once per epoch. New results append without rewriting older projections. When reducible retained source exceeds the high watermark, Sieve starts one `budget-rollover` epoch and recomputes newest-to-oldest toward target. Pi compaction remains responsible for unprunable context.

Eligible plain tools are `bash`, `grep`, `find`, `ls`, `rg`, `fd`, `heartbeat_status`, and Memory list. It preserves mutation/control output, unique `read`, Advisor/Scout/Grunt evidence, and Verify failures. Exact duplicate reads may be replaced only when path/range/content match and no intervening edit/write occurred; generic deduplication also requires exact tool/arguments/details/content equality. Failures, ambiguous/missing IDs, and uncertain source pass through safely.

When the latest active-branch compaction is Continuity V3, Sieve can also project eligible historical suffix results while keeping assistant blocks and the newest completed tool batch complete. Later non-Continuity compaction disables this; no digest is persisted.

Markers supply an exact `toolCallId` to `sieve_recall`. Recall requires a current-ledger ID, one unique matching raw active result, and matching tool/error/source identity; it returns a deep clone of all original content blocks. Stale, missing, ambiguous, or mismatched IDs fail closed. Recall is active only with enabled mode and active pruning.

## Epochs and telemetry

Epochs reset after start/reload/session replacement, compaction, branch navigation, model/provider or effective system/tool-schema change, setting change, reflow, rollover, or non-append/source mismatch—not after new messages, repeated hooks, or recall. This intentionally resets provider prefix when needed.

`/sieve status`, `pi-sieve:state-change`, and Pylon Web Inspector show epoch/fingerprint metadata, retained/saved characters, transforms, recalls, reflows, watermarks, prefix churn, and context usage. Cumulative counters are compact custom entries on the active branch and survive reload/resume; live ledgers and payload caches are runtime-only and rebuilt from raw context. Sieve does not trigger automatic compaction, and provider usage remains authoritative.