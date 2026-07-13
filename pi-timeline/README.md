# pi-timeline

Git-backed filesystem checkpoints paired with Pi user prompts. Requires non-bare Git repo with existing HEAD and safe index state.

Commands: `/timeline`, `/timeline list`, `/timeline jump ID`, `/timeline fork ID`, `/timeline clear`. Launcher: `pi-timeline resume`.

Sessions carrying valid `pi-conductor-run` metadata share one run timeline. Checkpoints from planner, executor, and future reviewer sessions appear together with phase labels; selecting a linked-session checkpoint switches to its owning session before restoring or forking. Sessions without metadata retain existing session-local behavior. Timeline reads persisted metadata only and does not depend on pi-continuity being installed.

Matching successful Verify metadata is attached to checkpoints using exact worktree identity and shown by `/timeline list`. Before Guard asks approval for a destructive action, Timeline attempts a recoverable checkpoint; Guard still owns approval and blocking.

After first completed turn, unnamed sessions receive a concise display name from their first prompt. Existing names and manually cleared names remain untouched.

Snapshots use `refs/pi-timeline/...` synthetic commits. HEAD, branch, stash, ignored files remain untouched. Ordinary untracked files are included; common credential paths such as `.env*`, `.npmrc`, `.pypirc`, key files, and credential files are refused. Git operations time out after two minutes. `/timeline clear` retires current-session checkpoint records and deletes their refs. Every restore requires confirmation. Native `/tree` remains conversation-only.

V1 refuses submodules, unmerged/active Git operations, changed HEAD, and noninteractive restore. Extensions execute with full user permissions; review source.
