# pi-timeline

Git-backed filesystem checkpoints paired with Pi user prompts.

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-timeline. Run `/reload` after installation.

## Requirements

- Non-bare Git repository
- Existing `HEAD`
- Safe index state

## Usage

Commands: `/timeline`, `/timeline list`, `/timeline jump ID`, `/timeline fork ID`, and `/timeline clear`.

Launcher: `pi-timeline resume`.

Every restore requires confirmation. Native `/tree` remains conversation-only.

## How It Works

Snapshots use `refs/pi-timeline/...` synthetic commits. Automatic checkpoints run only after mutation-capable tools change or may change Git-backed worktree state; read-only turns and unchanged `bash` calls skip capture. Explicit rollback and Guard checkpoints remain unconditional. `HEAD`, branch, stash, and ignored files remain untouched. New checkpoints record the symbolic HEAD ref, or detached state, for display only. `/timeline list` and the selector show branch state, ISO timestamp, then prompt message; internal checkpoint IDs remain available for direct `jump` and `fork` commands but are not shown in rows. Restore confirmation shows compatibility details. Older version 3 records without ref metadata remain usable and appear as `branch:unknown` when their repository and HEAD still match.

Ordinary untracked files are included; common credential paths such as `.env*`, `.npmrc`, `.pypirc`, key files, and credential files are refused. Git operations time out after two minutes. `/timeline clear` retires current-session checkpoint records and deletes their refs.

After the first settled turn, Timeline makes one bounded title-only model request using short excerpts from the first prompt and final response. Invalid or unavailable model output falls back to the first prompt. Existing names, manual renames, and manually cleared names remain untouched.

## Integrations

Sessions carrying valid `pylon-run` metadata share one run timeline. Checkpoints from planner, executor, and future reviewer sessions appear together. Selecting a linked-session checkpoint switches to its owning session before restoring or forking. Sessions without metadata retain session-local behavior. Timeline reads persisted metadata only and does not require pi-continuity.

Each subsequent explicit plan gets a new run ID but inherits the pylon timeline ID already attached to its current planner or executor session. Timeline groups sessions by that stable lineage, so checkpoints survive repeated plans and fresh executor handoffs. Legacy metadata without a timeline ID uses its run ID as the lineage root. Checkpoints from unrelated lineages stay excluded, and `/timeline clear` remains owner-session scoped.

Matching successful Verify metadata remains attached to checkpoints using exact worktree identity. Before Guard asks approval for a destructive action, Timeline attempts a recoverable checkpoint; Guard still owns approval and blocking.

## Security and Limitations

V1 refuses submodules, unmerged or active Git operations, cross-repository or cross-`HEAD` restore, and noninteractive restore. Timeline never checks out or switches branches: same-commit branch differences are informational, and restore changes only the index and working tree. Git state is inspected at capture and command boundaries rather than watched continuously. Restore rechecks repository identity and exact HEAD immediately before filesystem mutation, so UI compatibility labels never replace the authoritative safety check. Extensions execute with full user permissions; review source.
