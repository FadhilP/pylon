# Pylon

Bundled workflow extensions and a low-noise theme for [Pi](https://pi.dev). Pylon adds planning, repository research, verification, safety, outbound context limiting, background work, checkpoints, and UI improvements.

## Web App

Install Pylon globally, enter the project you want to work on, and run `pylon`:

```sh
npm install --global @fadhilp/pylon
cd /path/to/your/project
pylon
```

Before starting, Pylon checks npm for a newer stable release. In an interactive terminal it asks before installing; in non-interactive use it only prints the exact update command. After any approved install attempt, Pylon exits so it never starts from files npm may be replacing; run `pylon` again to use the updated package. Set `PYLON_NO_UPDATE_CHECK=1` to skip the check.

Then open [http://127.0.0.1:3141](http://127.0.0.1:3141). The web host binds only to loopback and uses the current directory as its initial project. `PYLON_CWD` overrides that directory; `PYLON_PORT` changes the default port (`3141`).

Go to settings to setup your preferred provider. Choose your models for Advisor, Scout, Grunt. Recommended configuration for openAI subscriptions:
- Main agent: GPT 5.6 Sol Medium
- Advisor: GPT 5.6 Sol High
- Scout: GPT 5.6 Luna Medium/High
- Grunt: GPT 5.6 Terra (Thinking level will be decided by main agent)

## Terminal Setup

Install the complete bundle from npm:

```sh
pi install npm:@fadhilp/pylon
```

Then reload Pi:

```text
/reload
```

For local development, install the checkout instead:

```sh
pi install /absolute/path/to/pylon
```

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
- **[pi-stateql](./packages/pi-stateql)** — Provides safe stateful database queries, durable result handles, confirmed writes, and bounded web status/history.
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

Install workspace dependencies and start the local web app from the repository root:

```sh
npm run install:packages
npm run web
```

For development without a production build, run `npm run dev --workspace @pylon/web`.

### Publishing

Configure npm Trusted Publishing for `@fadhilp/pylon` with repository `FadhilP/pylon` and workflow `publish.yml`; no npm token is required. Then update the version in `package.json` and `package-lock.json` and publish a GitHub Release with the matching tag, such as `v1.0.3`.

[`.github/workflows/publish.yml`](./.github/workflows/publish.yml) follows the same release flow as StateQL: it installs from the lockfile and runs `npm publish`, which triggers Pylon's verification, clean-package test, and build lifecycle.

Platform applications live under `platform/`: `platform/web` contains the current local web client and host, while `platform/desktop` reserves the future desktop shell.

Packages follow the same responsibility-based layout:

- `extensions/` contains Pi entrypoints, registration metadata, and runtime wiring.
- `packages/<name>/src/` contains reusable implementation modules; child/model system prompts live in each package's `src/prompts.ts`.
- `test/` mirrors the subject under test with `<subject>.test.ts` names.

Keep tool descriptions, `promptSnippet`, and `promptGuidelines` beside their tool registration because they are part of the extension API definition, not standalone model prompts.
