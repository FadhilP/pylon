# pi-scout

Bounded read-only repository reconnaissance and explicit Pi-session search for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-scout. Run `/reload` after installation.

## Configuration

Select an optional child model with `/scout provider/model-id[:thinking]` or `/scout`. Example: `/scout openai/gpt-5:medium`.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Without a suffix, Scout follows the current main thinking level.

- `/scout disable` disables repository and session scouts.
- `/scout reset` re-enables both using the current main model and thinking level.
- `pi config` can disable the extension.
- `pi --no-extensions` disables all extensions for one run.

## Repository Scout

Pi receives `repo_scout(task, retryReason?)`. The main model should call it before edits for non-local discovery, architecture or data-flow mapping, and cross-file impact. Scout gathers evidence; the main model owns evaluation, severity, exploitability, priority, architecture choices, and final conclusions.

Broad goals must become observable search criteria. Bad: `find critical vulnerabilities`. Better: `locate authentication and authorization boundaries; trace user-controlled input reaching SQL, shell, filesystem, network, deserialization, and secret-handling operations; cite missing checks and gaps`.

Calls are unlimited within one original user prompt. Later calls reuse the first child session when possible; `retryReason` supplies gap context. Each call receives a redacted, bounded handoff from recent parent context and tool intent. It can also receive log-free Verify results and Timeline checkpoint metadata.

Scout returns exact `path:start-end` citations and narrow excerpts. The main model treats those ranges as its working set, reads cited ranges when verification is needed, and expands only for a stated gap or changed context. Known-file micro-edits should skip Scout.

The isolated child has read-only `read`, `rg`, `fd`, `grep`, `find`, and `ls`. It has no shell, mutation tools, other extensions, skills, or context files. Activity history retains at most 100 events. Periodic cited checkpoints allow a timeout to return partial, non-repeated findings.

## Session Search

Only original user input beginning with `Search my Pi session ...` or `Search my Pi sessions ...` triggers search. The package scans at most 200 newest sessions, selects at most 12 user or assistant text excerpts, redacts likely credentials, caps evidence, and gives it to a tool-free child. Evidence and findings stay transient; the current session stores metadata only.

## Privacy and Cost

Every child call costs the selected model's rates. Cache savings are never assumed. Repository Scout sends its task and bounded recent parent context to the selected provider. Session search can send text from other workspaces. Redaction is defense in depth, not proof of secrecy.

Repository timeout is 15 minutes by default. Set `PI_SCOUT_TIMEOUT_MS` to `1..7200000` milliseconds to override it. Session-search timeout remains 90 seconds. Failures are nonfatal. Pi extensions run with full user permissions; review source before installation.
