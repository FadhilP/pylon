# pi-timeline

Git-backed filesystem checkpoints paired with Pi prompts, so you can inspect, restore, or fork working-tree states without changing branches.

## Install and requirements

Requires Pi, Node 22.19.0 or later, a non-bare Git repository with an existing `HEAD`, and a safe index state:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Package settings are available through Pylon Web.
Configuration is stored at `<agent-dir>/pi-timeline/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

| Command | Use |
| --- | --- |
| `/timeline`, `/timeline list`, `/timeline select` | View checkpoints |
| `/timeline restore ID` | Restore after confirmation |
| `/timeline fork ID` | Fork from a checkpoint |
| `/timeline clear` | Retire this session's records and refs |
| `/timeline help` | Show usage |
| `pi-timeline resume` | Resume launcher |

Every restore requires confirmation. Native `/tree` remains conversation-only.

## Checkpoints and titles

Timeline stores synthetic commits under `refs/pi-timeline/...` in every participating repository. It recursively includes initialized nested repositories from Git links/non-ignored embedded repositories, without requiring `.gitmodules`. A hidden session-start baseline means the first displayed change is measured from session start while the checkpoint still contains the complete worktree; later change labels compare to the previous checkpoint.

Automatic capture occurs only after mutation-capable tools change or may change Git-backed state. Read-only turns and unchanged Bash skip it; rollback and Guard checkpoints are unconditional. With Pylon, shell detection is shared once per turn with Continuity; standalone Timeline compares per call. Checkpoints do not change `HEAD`, branch, stash, or ignored files. They record branch/detached state only for display.

Semantic checkpoint titles are off by default. Pylon Web settings can enable current-session or separate-model titles. The filesystem checkpoint is always written first; a bounded background title request then uses short prompt/response/changed-path excerpts. Until valid output arrives, the prompt remains label. Each changed turn can add model cost. Session titles similarly run once after the first settled turn and never replace existing/manual/cleared names.

## Lifecycle and integrations

Format V6 stores the session-start baseline. V4+ records Git common-directory identity, allowing a Pylon session moved between linked worktree and registered checkout to retain refs/restoration. V3 migrates only from its original checkout; unprovable relocation fails closed. Git operations time out after two minutes.

Ordinary untracked files are included; common credential files (`.env*`, `.npmrc`, `.pypirc`, key files) are refused. On startup Timeline removes refs for deleted sessions with no live lease; failed session discovery/repository access fails closed. Ephemeral-session refs are removed on clean shutdown.

Valid Continuity `pylon-run` metadata groups planner/executor/reviewer checkpoints into one run timeline; linked checkpoint selection switches to its owner before restore/fork. Other sessions remain session-local. Matching successful Verify metadata attaches by exact worktree identity. Before Guard asks for destructive approval, Timeline attempts a recoverable checkpoint; Guard still controls approval/blocking.

## Safety and limitations

Timeline refuses escaped/cyclic nested repositories, over 100 physical roots, active/unmerged Git operations, cross-repository or cross-`HEAD` restore, and noninteractive restore. It never checks out or switches branches; restore changes only the index and working tree. It rechecks repository identity and exact `HEAD` immediately before mutation. Git state is checked at capture/command boundaries, not continuously. Extensions run with your permissions; review source.