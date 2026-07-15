# pi-guard

Conservative destructive-command and path guard for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-guard. Run `/reload` after installation.

## Usage

Run `/guard` to view session counters.

Pi Guard intercepts agent `bash`, `write`, and `edit` calls plus user `!` and `!!` shell commands. It asks once before recursive deletion, privilege escalation, destructive Git reset or clean, force push, disk writes, and recursive permission changes. Without confirmation UI, risky commands fail closed.

## Path Protection

Explicit absolute write/edit targets outside the workspace require fresh confirmation and fail closed without UI. Relative traversal and workspace symlink escapes remain blocked. Writes inside `.git` or `node_modules` are always blocked; `.env` writes require confirmation. Existing targets and nearest existing parents are canonicalized, and outside-write confirmation shows the resolved target.

## Integrations

When Timeline is installed, Guard requests a checkpoint before showing destructive confirmation. Failure or absence of Timeline never weakens Guard. Versioned, bounded `pi-guard:decision` events feed Focus status and Pylon diagnostics.

## Security and Limitations

V1 deliberately uses a narrow command policy. It is not a shell parser, sandbox, malware detector, or substitute for OS or container isolation. Path confirmation covers `write` and `edit`; unrecognized commands and shell-based writes retain full user permissions. Review commands and resolved external targets before approval.
