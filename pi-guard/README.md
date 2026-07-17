# pi-guard

Conservative destructive-command and path guard for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-guard. Run `/reload` after installation.

## Usage

Run `/guard` to view session counters.

Pi Guard intercepts agent `bash`, `write`, and `edit` calls plus user `!` and `!!` shell commands. For approvable risks it offers **Allow once**, **Always allow this session**, **Always allow on this project**, and **Deny**. Session approvals live only in the current extension instance; project approvals survive sessions in Pi's user-controlled agent directory (never the repository). Without confirmation UI, every risky command fails closed, including remembered approvals.

## Path Protection

Explicit absolute write/edit targets outside the workspace require approval and fail closed without UI. Remembered session/project approval covers the resolved target's parent directory and all descendants, so generated sibling and nested files do not need one-by-one approval; the prompt shows the directory being remembered. A target directly under a filesystem root stays exact-path scoped rather than approving the whole drive. Relative traversal and workspace symlink escapes remain blocked. Writes inside `.git` or `node_modules` are always blocked and cannot be approved; `.env` approvals remain exact-path scoped. Existing targets and nearest existing parents are canonicalized on every call.

## Integrations

When Timeline is installed, Guard requests a checkpoint before showing destructive confirmation. Failure or absence of Timeline never weakens Guard. Versioned, bounded `pi-guard:decision` events feed Focus status and Conductor diagnostics.

## Security and Limitations

V1 deliberately uses a narrow command policy. Approvals are keyed to the policy version, canonical project directory, risk reason, operation class, and exact command, exact protected path, or approved external directory. Command approval is shared by agent/user shell calls and path approval by `write`/`edit`. External-directory approval is pathname-based; targets are re-canonicalized before matching, but Pi Guard is not a filesystem sandbox and cannot eliminate filesystem race conditions. Project records are versioned per-key files with restrictive permissions where supported; malformed records grant nothing. It is not a shell parser, sandbox, malware detector, or substitute for OS or container isolation. Path confirmation covers `write` and `edit`; unrecognized commands and shell-based writes retain full user permissions. Review commands and resolved external targets before approval.
