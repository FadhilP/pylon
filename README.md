# Pi Conductor

Bundled workflow extensions and a low-noise theme for [Pi](https://pi.dev). Pi Conductor adds planning, repository research, verification, safety, background work, checkpoints, and UI improvements.

## Installation

Install the complete bundle from GitHub:

```sh
pi install git:github.com/FadhilP/pi-conductor
```

Then reload Pi:

```text
/reload
```

For local development, install the checkout instead:

```sh
pi install /absolute/path/to/pi-conductor
```

> **Security:** Pi extensions run with your user permissions. Review package source before installation.

## Requirements

- Node.js 22.18 or newer
- [Pi](https://pi.dev)
- Peer packages declared in [`package.json`](./package.json)

## Bundled Packages

- **[pi-advisor](./pi-advisor)** — Consults a selected tool-free model for difficult planning, architecture review, and failure recovery using bounded, redacted context.
- **[pi-conductor-core](./pi-conductor-core)** — Coordinates tool policies from Advisor, Scout, and Continuity while preserving standalone behavior.
- **[pi-continuity](./pi-continuity)** — Adds explicit plan mode, structured clarifications, visible task lists, and opt-in durable workspace memory.
- **[pi-focus](./pi-focus)** — Provides a low-noise Pi terminal UI, compact or comfortable layouts, and the `focus-dark` theme.
- **[pi-guard](./pi-guard)** — Intercepts risky shell and file operations, requests confirmation for known destructive actions, and blocks unsafe writes.
- **[pi-heartbeat](./pi-heartbeat)** — Runs bounded background shell jobs with tools for starting, checking, and cancelling jobs.
- **[pi-helios](./pi-helios)** — Captures consented Windows-window or browser-viewport screenshots for vision-based debugging.
- **[pi-scout](./pi-scout)** — Performs bounded, read-only repository reconnaissance with exact source citations and explicit Pi-session search.
- **[pi-timeline](./pi-timeline)** — Creates Git-backed filesystem checkpoints tied to prompts and supports listing, restoring, forking, or clearing them.
- **[pi-verify](./pi-verify)** — Detects and runs existing project checks with bounded time and output.

The bundle also installs the [`focus-dark`](./pi-focus/themes/focus-dark.json) theme.

## Integrations

Packages coordinate through bounded, versioned event-bus metadata while remaining functional without Conductor:

- Verify publishes lifecycle and results; Continuity gates completion, Timeline marks matching checkpoints, Advisor receives bounded recovery metadata, and Focus shows status.
- Guard requests a Timeline checkpoint before destructive confirmation and remains final safety authority; Conductor reports its latest decision.
- Heartbeat publishes job lifecycle with optional todo and purpose metadata; Continuity tracks explicitly linked jobs.
- Scout receives bounded verification and checkpoint archaeology from parent session metadata.
- Continuity supports `/plan review`, recording the shared run's `reviewer` phase for Timeline grouping.

Raw verification and Heartbeat logs never cross package events.
