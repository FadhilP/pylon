# Pylon

Bundled workflow extensions and a low-noise theme for [Pi](https://pi.dev). Pylon adds planning, repository research, verification, safety, outbound context limiting, background work, checkpoints, and UI improvements.

## Installation

Install the complete bundle from GitHub:

```sh
pi install git:github.com/FadhilP/pylon
```

Then reload Pi:

```text
/reload
```

For local development, install the checkout instead:

```sh
pi install /absolute/path/to/pylon
```

> **Security:** Pi extensions run with your user permissions. Review package source before installation.

## First-run Setup

Select models for the child-agent tools after reloading. Replace the examples with models available through your configured Pi providers:

```text
/advisor
/grunt
/scout
```

Advisor, Grunt, and Scout stay unavailable until configured. In TUI mode, `/advisor`, `/grunt`, and `/scout` open model selectors. Each command's `reset` option configures that tool with the current main model; `disable` turns it off. With Pylon, configured specialist tools remain deferred until `search_tools` activates the relevant capability. Use `status` to inspect configuration.

Optional Continuity planner and executor profiles can use separate models:

```text
/continuity planner
/continuity executor
```

Run `/pylon doctor` to check model availability, credentials, dependencies, tool registration, and package health. See each package README below for detailed configuration, limits, privacy, and cost behavior.

## Requirements

- Node.js 22.18 or newer
- [Pi](https://pi.dev)
- Peer packages declared in [`package.json`](./package.json)

## Bundled Packages

- **[pi-advisor](./packages/pi-advisor)** — Consults a selected tool-free model for difficult planning, architecture review, and failure recovery using bounded, redacted context.
- **[pylon-core](./packages/pylon-core)** — Coordinates package tool policies, deduplicates shell worktree observation, and reports per-tool estimated session payload tokens.
- **[pi-continuity](./packages/pi-continuity)** — Adds explicit plan mode, structured clarifications, visible task lists, and opt-in durable workspace memory.
- **[pi-focus](./packages/pi-focus)** — Provides a low-noise Pi terminal UI, compact or comfortable layouts, and the `focus-dark` theme.
- **[pi-guard](./packages/pi-guard)** — Intercepts risky shell and file operations, requests confirmation for known destructive actions, and blocks unsafe writes.
- **[pi-grunt](./packages/pi-grunt)** — Runs a synchronous delegated implementation worker for compact slices or complete non-difficult changes with main-selected thinking.
- **[pi-heartbeat](./packages/pi-heartbeat)** — Runs bounded background shell jobs with tools for starting, checking, and cancelling jobs.
- **[pi-helios](./packages/pi-helios)** — Provides owned Playwright browsers with isolated profiles, consent-gated browser attachment, and named Windows-window screenshots.
- **[pi-discover](./packages/pi-discover)** — Indexes supported source files in local SQLite for symbol and lexical code search, provides read-only repository search, and coordinates inactive-tool discovery.
- **[pi-scout](./packages/pi-scout)** — Performs bounded repository reconnaissance, fresh-browser isolated public-web research, and explicit Pi-session search.
- **[pi-sieve](./packages/pi-sieve)** — Limits old bulky successful tool output in outbound context without modifying stored session messages.
- **[pi-timeline](./packages/pi-timeline)** — Creates Git-backed filesystem checkpoints tied to prompts and supports listing, restoring, forking, or clearing them.
- **[pi-verify](./packages/pi-verify)** — Detects and runs existing project checks with bounded time and output.

The bundle also installs the [`focus-dark`](./packages/pi-focus/themes/focus-dark.json) theme.

## Integrations

Packages coordinate through bounded, versioned event-bus metadata while remaining functional without Pylon:

- Verify publishes lifecycle and results; Continuity gates completion, Timeline marks matching checkpoints, Advisor receives bounded recovery metadata, and Focus shows status.
- Guard requests a Timeline checkpoint before destructive confirmation and remains final safety authority; Pylon reports its latest decision.
- Pylon fingerprints the worktree once around each model turn containing shell calls; Continuity and Timeline consume the shared mutation result while retaining standalone fallbacks.
- Heartbeat publishes job lifecycle with optional todo and purpose metadata; Continuity tracks explicitly linked jobs.
- Grunt performs sequential implementation in an isolated temporary Git worktree by default, applying successful non-stale patches back to the parent. Direct mode edits the current working directory without rollback guarantees; dynamic mode selects isolation when Git `HEAD` exists and direct execution otherwise. Main retains architecture, review, and final verification; Advisor consultation remains optional and evidence-driven.
- Advisor, Grunt, repository Scout, Continuity, and Memory stay active when configured so their workflow guidance remains visible. Discover keeps `rg`, `fd`, and `search_tools` active while Pylon defers optional browser and capture schemas until discovery selects them; restrictive gates remain authoritative.
- Scout receives bounded verification and checkpoint archaeology from parent session metadata.
- Continuity supports `/plan review`, recording the shared run's `reviewer` phase for Timeline grouping.

Raw verification and Heartbeat logs never cross package events.

## Development

Packages follow the same responsibility-based layout:

- `extensions/` contains Pi entrypoints, registration metadata, and runtime wiring.
- `packages/<name>/src/` contains reusable implementation modules; child/model system prompts live in each package's `src/prompts.ts`.
- `test/` mirrors the subject under test with `<subject>.test.ts` names.

Keep tool descriptions, `promptSnippet`, and `promptGuidelines` beside their tool registration because they are part of the extension API definition, not standalone model prompts.
