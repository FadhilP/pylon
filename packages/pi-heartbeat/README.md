# pi-heartbeat

Bounded background shell jobs for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-heartbeat. Run `/reload` after installation.

## Usage

Tools: `heartbeat_start`, `heartbeat_status`, and `heartbeat_cancel`.

User command: `/heartbeat [list|status ID|cancel ID]`.

`heartbeat_start` starts up to four long shell jobs and returns an ID immediately. It requires concrete independent work while waiting; otherwise use normal `bash`. Running-job status checks must be more than 30 seconds apart.

Optional arguments include `todoId` and `purpose` (`verification`, `build`, or `other`). Use `purpose: "verification"` for long declared project checks while independent work remains. Versioned `pi-heartbeat:job` events contain lifecycle metadata only; Continuity updates explicitly linked todos.

## Lifecycle

Jobs and logs exist only in the current extension runtime. Reload, session replacement, or exit kills process trees, waits at most five seconds, then deletes external logs. UTF-8 tails and full-log writes are ordered; output and log sizes remain bounded. No automatic polling or extra model calls occur.

## Security and Limitations

Commands have the same authority as Pi `bash`: they can modify files and are not sandboxed. Deliberately detached grandchildren may escape process-tree termination. Continuity plan mode blocks Heartbeat tools.
