# pi-guard

A conservative confirmation guard for destructive shell commands and risky write/edit paths in Pi.

## Install and use

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi, then run `/guard` for session counters. Guard intercepts agent `bash`, `write`, and `edit`, plus user `!` and `!!` commands. For approvable risks it offers **Allow once**, **Always allow this session**, **Always allow on this project**, or **Deny**. Without confirmation UI, all risky actions fail closed, including remembered approvals.

Session approvals last only for the extension runtime. Project approvals are stored in Pi's user-controlled agent directory, never the repository. Because Pi Bash is Bash on every platform, Guard blocks redirection to bare `nul` (which creates a file); use `/dev/null`, or explicit `./nul` if that file is intentional.

## Protected paths and policy

Explicit absolute writes/edits outside the workspace need approval. A remembered external-directory approval covers its canonical parent and descendants; a target directly under a filesystem root remains exact-path scoped. Relative traversal and workspace symlink escapes are blocked. `.git` and `node_modules` are always blocked and cannot be approved; `.env` approval is exact-path only. Existing targets and nearest existing parents are canonicalized for every call.

Pylon may supply `guardRules` in `pylon:runtime-policy` version 2. Values are `allow`, `confirm`, or `block`; omitted categories keep standalone defaults. Invalid policy blocks every detected category.

| Categories | Default |
| --- | --- |
| privilege escalation, recursive deletion, destructive reset/clean, forced push, disk/raw-device changes, recursive permission changes | confirm |
| `.git`, `node_modules`, workspace escape | block |
| outside workspace, environment file | confirm |

## Integrations and limits

When Timeline is installed, Guard requests a checkpoint before destructive confirmation; Timeline failure never weakens Guard. Bounded `pi-guard:decision` events feed Focus and Pylon diagnostics.

Approvals are keyed by policy version, canonical project, category, operation, and exact command/path or approved external directory. Malformed records grant nothing. Guard is deliberately not a shell parser, filesystem sandbox, malware detector, or substitute for OS/container isolation. Shell-based writes and unrecognized commands retain your normal permissions; filesystem races remain possible. Review commands and resolved external targets before approving them.