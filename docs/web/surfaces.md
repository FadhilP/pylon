# Surfaces and references

[Guide index](./README.md) · [Workspaces and sessions](./workspaces-and-sessions.md) · [Settings](./settings.md) · [Troubleshooting](./troubleshooting.md)

Pylon Web changes views around the selected session. A view can be absent when its package, tool, project state, or session is unavailable. Enable/configure the relevant package in **Settings → Packages**, then start or refresh a session as needed.

## Chat and composer

**Chat** is the main conversation. The composer sends a prompt, queues a follow-up while work is running, and offers controls for the current session model and supported thinking level. **Plan mode** is available only when Continuity's planning capability is available.

The composer accepts supported image and text-file attachments and workspace-file references. It also exposes follow-up, queue, abort, edit, rewind, and fork workflows described in [Workspaces and sessions](./workspaces-and-sessions.md). Tool output, generated text, and attachments can appear in conversation history and may be sent to the selected provider.

## Files and Changes

**Files** is session-aware. It lists workspace files, shows current/base/diff content when available, and marks changed paths. Content can be unavailable for deleted, binary, oversized, or otherwise unsupported files. The Files view also exposes the workspace's Git status, setup state, handoff options, and reviewed apply workflow.

The **Changes** Inspector reference is a compact changed-file and diff view when Files is not the main surface. **Turn Diff** opens a changed-file view attached to an individual conversation turn. These are inspection tools, not a substitute for Git status or a full editor.

## Browser

The **Browser** surface appears only when [Helios](../../packages/pi-helios/README.md) is active and browser capability is available for the session. It needs a ready session. It can launch or directly control a Helios-owned browser through a local, temporary mirror; starting direct control pauses agent browser actions while the panel owns the control lease.

Helios does not automatically download a browser. Install compatible Chrome through Helios when required. User-attached browsers remain tool-only: Pylon Web does not mirror or directly control them. Browser snapshots and screenshots can contain sensitive page content; screenshots cannot be reliably redacted. See [Safety and storage](./safety-and-storage.md).

Helios also supports Android workflows, but those are not a Browser-surface prerequisite. Android needs user-managed Android SDK tools, Java, and an existing AVD. Pylon can install its managed Appium/UiAutomator2 tooling after confirmation in **Settings → Packages → pi-helios**; it does not create an AVD or modify global npm. See [Helios](../../packages/pi-helios/README.md).

## Database

The **Database** surface appears only when [StateQL](../../packages/pi-stateql/README.md) is enabled and database capability is available in the current session. It provides a bounded local workspace/history view: connection metadata, transaction ownership, recent handles and operations, and explicitly expanded result pages. It is not a general database administration console.

StateQL controls remain authoritative. Connection changes, writes, plan application, transactions, and profile removal require interactive confirmation. SQL, parameters, and returned rows can enter Pi history and may be sent to the selected provider. Pylon Web may request a credential in a masked dialog for supported StateQL flows; see [Safety and storage](./safety-and-storage.md).

## Terminal

**Terminal** is an ambient drawer for the selected ready session. It starts a local shell in that session's workspace: PowerShell on Windows, or `$SHELL`/`/bin/sh` elsewhere. It is one terminal per session and closes when that session deactivates, becomes unavailable, exits, or the server closes. A terminal uses your local account and its normal permissions; it is not a sandbox and is separate from agent tool confirmations.

## Inspector references

The Inspector rail follows the selected session. Depending on packages and state, it contains:

| Reference | Use | Availability |
| --- | --- | --- |
| **Overview** | Live session state, task/work progress, and usage summary. | Available for a session. |
| **Policy** | Project and session behavior; global defaults are in Settings. | Available for a session. |
| **Timeline** | Recoverable checkpoints for the current run. | Requires enabled Timeline and a compatible Git workspace. |
| **Memory** | Durable project context and workflow-friction records. | Requires Continuity memory or Papercut capability. |
| **Tools** | Project/session overrides for registered tools. | Available for a session. |
| **Changes** | Touched files and diffs. | Hidden while Files already shows it. |
| **Agents** | Delegated runs spawned by the session. | Available; may be empty. |
| **Compaction** | Inspect the current compaction workflow when it is present. | Contextual to compaction activity. |
| **Attachments** | Inspect message attachments. | Contextual to a message with attachments. |
| **Turn Diff** | Inspect changed files from one transcript turn. | Contextual to a turn with changes. |
| **Chat** | The same conversation while another main surface is open. | Shown when Files, Browser, or Database displaces Chat. |

Timeline requires a non-bare Git repository with an existing `HEAD` and a safe Git state. Review [Timeline](../../packages/pi-timeline/README.md) for checkpoint and restore limits. Memory behavior comes from [Continuity](../../packages/pi-continuity/README.md); delegated runs depend on their configured packages.

## Workspace views

- **All sessions** returns to the project/session navigator.
- **Archive** searches archived projects and sessions and restores them.
- **Usage** presents usage information for the workspace.

These workspace views do not replace the selected session's Chat or Inspector state. Return to a session to act on it.
