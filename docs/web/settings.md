# Settings

[Guide index](./README.md) · [Surfaces](./surfaces.md) · [Safety and storage](./safety-and-storage.md) · [Troubleshooting](./troubleshooting.md)

Open **Settings** from the workspace chrome. Settings change local Pylon/Pi configuration; they do not change source files unless a package or extension is explicitly designed to do so.

## Setting scopes and inheritance

| Scope | Where it applies |
| --- | --- |
| Global | Pylon Web defaults, including package defaults and global runtime/tool policy. |
| Project | A registered project's workspace, Verify, safety, and tool overrides. |
| Session | Overrides for one session. |
| Package-backed | Settings owned and validated by an installed package, normally stored in Pylon Web's agent-data scope. |

For runtime policy and tool exposure, the effective value is **global → project → session**: the nearest explicit override wins, while inherited values follow their source. The Policy reference shows project, session, and effective values. Global changes do not erase closer overrides. Package settings are package-specific defaults, not project/session policy overrides.

Save timing is shown by a package field when the package provides it. A change may take effect immediately, on the next operation, next session, after reload, or at package-defined timing. If a package says a setting applies to a future session, create or restart that session rather than expecting the current runtime to change.

## Providers

**Providers** lists available providers and whether each is connected. Use **Add key** or **Sign in** for an interactive API-key or OAuth flow when offered. Some providers are configured outside Pylon and are shown as external rather than editable here.

Disconnect removes a credential only when Pylon reports it as stored and active sessions are idle. Provider credentials are sensitive: use the provider flow/dialog, do not paste them into prompts, and see [Safety and storage](./safety-and-storage.md) for disclosure limits.

## Models

**Models** controls which provider models are visible in Pylon's model selectors. Filter by provider/model, show or hide individual models, or show all models for a provider. Hiding a model does not remove provider access or change an already active session model; the active model remains visible. If no models appear, connect/configure a provider first.

## Agent models

**Agent models** configures the models and thinking levels used by Pylon agents and background package tasks. Only package settings that expose agent-model fields appear. This is separate from the current Chat session's model selector and from the Models tab's visibility filter.

Choose only models that your connected provider makes available. A hidden model can remain selected by a package, but visibility settings affect what is offered in selectors; verify a package's current configuration before disabling a provider or model.

## Packages

**Packages** discovers local Pylon/Pi packages, shows status, enables or disables optional packages, and exposes each package's validated defaults. `pylon-core` is required and cannot be disabled. A package can be enabled yet unavailable if it fails to load or lacks prerequisites.

The package detail also shows managed **Tool exposure**. Package defaults can make a tool active, deferred, or disabled; global policy can override supported tools, and project/session Policy can override them again. Deferred means the tool is not initially exposed and may need the package's activation path (commonly `search_tools`). A disabled or unavailable package cannot be made capable merely by changing exposure.

Package-specific references:

- [Continuity](../../packages/pi-continuity/README.md) for planning, memory, and compaction.
- [Timeline](../../packages/pi-timeline/README.md) for Git checkpoints.
- [Guard](../../packages/pi-guard/README.md) for guarded operations.
- [Verify](../../packages/pi-verify/README.md) for project checks.
- [Helios](../../packages/pi-helios/README.md) for browser and Android prerequisites.
- [StateQL](../../packages/pi-stateql/README.md) for database access and confirmations.

### Agent-facing package changes

`pylon_settings` is a **Web-only**, deferred agent tool. It can list, inspect, and update validated **package settings only**. An update must use a fresh revision from an inspection and requires explicit confirmation. The agent should preserve unrelated settings and use the package settings interface rather than editing JSON.

It cannot change hooks, project policy, project trust, extensions, Guard controls, credentials, raw JSON, arbitrary files, or non-package settings. Package prompt changes affect future package behavior and do not rewrite the current system prompt.

## Extensions

**Extensions** manages Pi-native extensions and extension packages in user or project scope. You can enable/disable a resolved extension, install/remove a supported package source, reload extensions, and inspect load errors. Reload after changing extension configuration when prompted by the UI.

Extensions and extension packages run arbitrary code with the Pylon server's permissions. Review their source and package origin before enabling them. Project-scoped extension changes require a trusted project; trust permits loading project resources, it does not sandbox them. See [Safety and storage](./safety-and-storage.md).

## Hooks

**Hooks** adds local instruction sources at two lifecycle points:

- **Session start** contributes instructions when a session starts and can be reinjected after compaction when that source requests it.
- **Before agent start** contributes instructions immediately before an agent run starts.

You can write instructions or import Markdown/text snapshots. Hooks are lifecycle instructions, not the user's Chat prompt and not a general raw-system-prompt editor. Package prompt settings are also different: they are validated fields owned by a package and can apply at the package's stated time. The Web-only `pylon_settings` tool cannot edit hooks.

## Policy

**Settings → Policy** sets global defaults for Timeline, Guard, Guard rules, workspace mode, Guard confirmation timeout, and clarification timeout. It also explains the global → project → session inheritance order.

Use the selected session's **Inspector → Policy** reference to set project and session values and inspect the effective policy. Verify is configured there per project/session rather than as a global default. Tool exposure can likewise be adjusted at global, project, or session scope only for registered package tools. Changes may wait for affected active sessions to become idle before their runtime configuration is refreshed.

Guard rules control how Guard handles its supported risk categories; they are not a general operating-system sandbox. Timeline needs Git prerequisites. Workspace chooses Local, Project folder, or Session worktree for newly created sessions. A timeout controls how long a Guard confirmation or clarification can remain open; use the UI's supported choices rather than assuming an unlisted value.

## Notifications

**Notifications** lets you preview the local sound cues for **Turn complete** and **Attention required**. They are browser-side cues; allow audio in the browser if preview or playback is blocked.

## Appearance

**Appearance** selects the Pylon color theme and code syntax-highlighting theme. Syntax themes and languages load after startup, so highlighting can appear after the rest of the workspace.
