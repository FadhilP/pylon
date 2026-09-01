# Safety and storage

[Guide index](./README.md) · [Getting started](./getting-started.md) · [Settings](./settings.md) · [Troubleshooting](./troubleshooting.md)

## Local Web boundary

Pylon Web is loopback-only. The server accepts `127.0.0.1` or `::1`, not a LAN address. Requests must use the server's exact loopback host and port; host filtering, same-origin checks, a local browser session, and CSRF protection protect the local API. This is a local-access boundary, not a guarantee that every operation stays private from providers or local software running as your user.

Use the printed loopback URL on the same machine. Do not put the URL behind a reverse proxy or expose its port to a network as a supported configuration.

## What can leave the machine

Provider requests can include the prompt, conversation context, selected attachments, and tool results needed by the session. Browser text/snapshots, screenshots, database SQL/rows, shell output, and source snippets can therefore be sensitive. Pylon's local host does not promise provider secrecy. Choose providers and prompts accordingly, inspect tool output before sharing it, and avoid entering secrets unless the workflow requires it.

Credentials handled through supported provider dialogs remain machine-local where the provider/Pi integration supports that. Do not treat that as a promise that all data is secret: prompts and tool output are a different path. StateQL's supported Web credential dialog keeps submitted database credentials only in server memory for its bounded, approved context and does not put them in transcript/tool details, diagnostics, or StateQL persistence; database content still has the disclosure boundary above.

## Confirmations and controls

| Class | What to expect |
| --- | --- |
| Guarded shell/file operation | [Guard](../../packages/pi-guard/README.md) can allow, require confirmation, or block supported risky categories. Without confirmation UI, risky operations fail closed. |
| Timeline restore/fork | [Timeline](../../packages/pi-timeline/README.md) requires compatible Git state; restore requires confirmation. |
| Workspace handoff/apply | Requires the session to be idle and a compatible project checkout; apply needs explicit approval and reports conflicts/errors. |
| StateQL connection/write/transaction action | StateQL requires interactive confirmation for connection changes, writes, plan application, transaction commit/rollback, and profile removal. |
| Helios attachment/Android action | Some browser attachment, user-owned tab, Android start/attach, and tooling actions require visible confirmation. |
| Extension package or project trust change | Installing/removing extension packages, reloading, and trust-sensitive project changes require deliberate action; extensions execute code. |
| Package settings through an agent | `pylon_settings` needs a fresh revision and explicit confirmation, and is restricted to validated package settings. |

Confirmations reduce accidental action; they are not a substitute for reviewing commands, targets, provider output, or Git changes.

## Trust, isolation, and authority

**Project trust is not sandboxing.** Trust allows project-scoped Pi resources such as extensions to load when Pi considers them trust-requiring. A trusted extension runs arbitrary code with the server's permissions. An untrusted project is not a container and does not make ordinary files or commands safe.

**Guard is not sandboxing either.** It recognizes supported destructive commands and paths, but shell commands and extensions still run with your local user permissions. It blocks certain protected paths and workspace escapes according to policy, yet cannot replace OS accounts, containers, virtual machines, backups, or code review.

**Workspace isolation has a narrower meaning.** A Session worktree separates that session's Git working tree from the registered checkout. Local mode works in the project folder; Project-folder mode uses a Pylon branch there. Handoff and apply perform guarded Git workspace operations, not a security boundary. Read [Workspaces and sessions](./workspaces-and-sessions.md) before applying a delta to a checkout.

Packages and extensions have authority to run their own code in the local host process context. Enable only packages you intend to use, inspect load errors, and review third-party extension sources before installation.

## Storage scopes

Pylon Web and independently installed Pi packages do **not** share an implied storage root.

| Location / scope | Meaning |
| --- | --- |
| `~/.pylon/agent` | Default Pylon Web agent-data directory. Pylon Web stores its Pi-backed state here unless overridden. |
| `~/.pi/agent` | Legacy Pi agent-data directory copied into the default Pylon directory on migration. The source remains in place. It is also the normal host Pi agent directory for independently installed packages. |
| `PI_CODING_AGENT_DIR` for `pylon` | Overrides Pylon Web's agent-data directory instead of `~/.pylon/agent`. |
| `<Pylon agent dir>/pylon-web/projects.json` | Pylon Web project registry, including project/session organization and runtime-policy records. |
| `<Pylon agent dir>/pylon-web/packages.json` | Pylon Web enabled-package selection. |
| `<Pylon agent dir>/pylon-web/hooks.json` | Pylon Web hook settings. |
| Host Pi agent directory | Independently installed packages use the host Pi agent directory, normally `~/.pi/agent`, unless that host Pi is separately given `PI_CODING_AGENT_DIR`. This is not changed merely because Pylon Web uses `~/.pylon/agent`. |
| StateQL platform data directory | StateQL uses its own platform data location; `STQL_HOME` overrides it. See [StateQL](../../packages/pi-stateql/README.md). |

Pylon's default migration copies `~/.pi/agent` to `~/.pylon/agent` only when the target is absent. It does not delete the legacy directory or overwrite an existing Pylon target. If an automatic migration fails and legacy data exists, Pylon may use the legacy directory for that run and tells you to run `pylon migrate` later. `pylon migrate` retries the default-path copy; an explicit `PI_CODING_AGENT_DIR` is a separate choice.

## Backups, migration, and recovery

Before storage repairs, upgrades, or experimentation, stop Pylon and back up the relevant whole directory—not just a registry file. Back up `~/.pylon/agent` for default Pylon Web, and back up `~/.pi/agent` separately if you use standalone Pi/packages or still have legacy state. Back up an override directory instead when `PI_CODING_AGENT_DIR` is in use. Preserve directory permissions and do not merge two live agent directories by hand.

If migration fails, keep both source and partial destination for recovery, read the startup error, and retry `pylon migrate` only after resolving the filesystem problem. A migration is a copy, not a synchronization system: later changes to `~/.pi/agent` are not continuously mirrored into `~/.pylon/agent`.

Pylon can recover its own recorded project/session organization only when its agent data remains intact. It cannot recover deleted project files, provider-side history, uncommitted Git data that was never checkpointed/backed up, or credentials unavailable from their owning provider/OS integration. Use Git, provider controls, and normal system backups for those boundaries.
