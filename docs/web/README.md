# Pylon Web guide

Pylon Web is the local, browser-based Pylon workspace. It is for people who want to run coding sessions on their own machine, work across projects, and review agent activity without exposing the Web server to a network.

## Start here

1. Read [Getting started](./getting-started.md) to install Pylon, start it, and understand its local storage.
2. Add a project and create a session with [Workspaces and sessions](./workspaces-and-sessions.md).
3. Use [Surfaces](./surfaces.md) to find Chat, Files, Browser, Database, Terminal, and Inspector views.

## Guides

- [Getting started](./getting-started.md) — install, launch, providers, storage migration, and updates.
- [Workspaces and sessions](./workspaces-and-sessions.md) — projects, General, session history, Git workspaces, handoff, and apply.
- [Surfaces](./surfaces.md) — the main workspace views, Inspector references, Archive, and Usage.
- [Settings](./settings.md) — providers, models, packages, extensions, hooks, policy, notifications, and appearance.
- [Safety and storage](./safety-and-storage.md) — loopback access, confirmations, trust, data boundaries, and recovery.
- [Troubleshooting](./troubleshooting.md) — startup, connection, provider, package, Git, and storage problems.

## Scope

Pylon Web listens only on loopback. Use the URL printed by `pylon` (normally `http://127.0.0.1:3141`) from the same machine. Local hosting does not mean that prompt text, attachments, or tool output cannot be sent to the provider selected for a session; review [Safety and storage](./safety-and-storage.md) before entering sensitive material.

For package-specific behavior, see the linked package READMEs throughout these guides.
Agents can use the deferred `pylon_docs` tool to list and read these shipped guides on demand. Their content is not injected into ordinary prompts.
