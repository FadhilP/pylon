# pi-heartbeat

Bounded background Bash jobs for Pi, for work that can run while the agent does other concrete independent work.

## Install and use

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Pylon Web exposes package settings.
Configuration is stored at `<agent-dir>/pi-heartbeat/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

| Tool / command | Use |
| --- | --- |
| `heartbeat_start` | Start a long job and return its ID |
| `heartbeat_status` | Check a job or collect its result |
| `heartbeat_cancel` | Cancel an active job |
| `/heartbeat [list [running|all]|status ID|cancel ID|help]` | Manage jobs; bare command lists running jobs |

Up to four jobs run at once. Jobs use Pi's configured Bash shell on every platform, so commands use normal `bash` syntax. Use normal `bash` when there is no independent work to do while waiting. Optional `todoId` links a Continuity todo; `purpose` is `verification`, `build`, or `other`. Pylon only exposes status while a job is active or has an unread result, and cancel while it is active. Targeted status snapshots may repeat or omit prior output; list status is metadata-only, and running-job checks must be more than 30 seconds apart.

## Lifecycle, safety, and limits

Jobs and logs exist only in the current extension runtime. Reload, session replacement, or exit kills their process trees, waits up to five seconds, and deletes external logs. UTF-8 output tails, full logs, and returned output are bounded. There is no automatic polling or extra model call. Versioned `pi-heartbeat:job` events contain lifecycle metadata only; Continuity explicitly updates linked todos.

Jobs have the same authority as Pi `bash`, can modify files, and are not sandboxed. Deliberately detached grandchildren may escape process-tree termination. Continuity plan mode blocks Heartbeat tools.