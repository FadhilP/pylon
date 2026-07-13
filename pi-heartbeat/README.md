# pi-heartbeat

Starts up to four long shell jobs, returns IDs immediately, supports later status/cancel. `heartbeat_start` requires concrete independent work to do while waiting; otherwise use normal `bash`. Running-job status checks must be more than 30 seconds apart. Tools: `heartbeat_start`, `heartbeat_status`, `heartbeat_cancel`. User command: `/heartbeat [list|status ID|cancel ID]`.

`heartbeat_start` accepts optional `todoId` and `purpose` (`verification`, `build`, or `other`). Versioned `pi-heartbeat:job` events contain lifecycle metadata only; Continuity updates explicitly linked todos. Use `purpose: "verification"` for long declared project checks while independent work remains.

Jobs/logs exist only in current extension runtime. Reload, session replacement, or exit kills process trees, waits at most five seconds, then deletes external logs. UTF-8 tails and full-log writes are ordered; output/log size remains bounded. No automatic polling or extra model calls.

Commands have same authority as Pi `bash`: they can modify files and are not sandboxed. Deliberately detached grandchildren may escape process-tree termination. Continuity plan mode blocks heartbeat tools.
