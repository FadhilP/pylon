# Pylon

Pylon is a web-first coding agent workspace built on [Pi](https://pi.dev). It combines planning, repository research, delegated implementation, verification, safety controls, checkpoints, and a low-noise interface in one bundle.

Pylon is optimized for **cost efficiency and output quality rather than speed**. It routes focused work to cost-effective models and reserves stronger models for decisions that benefit from them, while verification and specialist reviews help protect quality. This workflow can take longer than using a single model directly.

## Web App Setup (Recommended)

Pylon requires Node.js 22.19 or newer. Install it globally, open the project you want to work on, and start the web app:

```sh
npm install --global @fadhilp/pylon
cd /path/to/your/project
pylon
```

Open [http://127.0.0.1:3141](http://127.0.0.1:3141), then use **Settings** to configure providers, package models, Continuity memory, revision-guarded numbered edits, Grunt thinking levels, and Spawn model/thinking eligibility.

Recommended configuration for OpenAI subscriptions:

- Main agent: GPT 5.6 Sol Medium
- Advisor: GPT 5.6 Sol High
- Scout: GPT 5.6 Luna Medium
- Grunt: GPT 5.6 Terra (the main agent selects the thinking level)

The server binds only to loopback and uses the directory where you ran `pylon` as the initial project. Set `PYLON_CWD` to override that directory or `PYLON_PORT` to change the default port (`3141`).

Pylon Web stores sessions, settings, and package state in `~/.pylon/agent` by default. Set `PI_CODING_AGENT_DIR` to override it. Existing `~/.pi/agent` data is copied non-destructively on first run; run `pylon migrate` to retry migration.

Pi-native extensions can be managed from **Settings → Extensions**. Global extensions and installed packages are stored under Pylon’s configured agent directory (`~/.pylon/agent/extensions`, `npm`, and `git` by default); later changes under `~/.pi/agent` are not synchronized. Trusted project extensions continue to use `<project>/.pi/extensions`. Extensions execute arbitrary code with the Pylon server’s permissions, so review package sources before installing or enabling them.

Before startup, Pylon checks npm for a newer stable release. Interactive terminals ask before updating; non-interactive sessions only print the update command. After an approved update attempt, run `pylon` again. Set `PYLON_NO_UPDATE_CHECK=1` to disable the check.

## Terminal Setup (Alternative)

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

- Node.js 22.19 or newer
- [Pi](https://pi.dev)
- Peer packages declared in [`package.json`](./package.json)

## Bundled Packages

- **[pi-advisor](./packages/pi-advisor)** — Consults a selected tool-free model for difficult planning, architecture review, and failure recovery using bounded, redacted context.
- **[pylon-core](./packages/pylon-core)** — Coordinates package tool policies, provides revision-guarded numbered read/edit tools by default, deduplicates shell worktree observation, and reports per-tool estimated session payload tokens.
- **[pi-continuity](./packages/pi-continuity)** — Adds explicit plan mode, structured clarifications, visible task lists, and opt-in durable workspace memory.
- **[pi-papercut](./packages/pi-papercut)** — Captures small non-blocking workflow frictions in a durable project backlog and supports listing, resolving, dismissing, and reopening them.
- **[pi-focus](./packages/pi-focus)** — Provides a low-noise Pi terminal UI, compact or comfortable layouts, and the `focus-dark` theme.
- **[pi-guard](./packages/pi-guard)** — Intercepts risky shell and file operations, requests confirmation for known destructive actions, and blocks unsafe writes.
- **[pi-grunt](./packages/pi-grunt)** — Runs a synchronous delegated implementation worker for compact slices or complete non-difficult changes with configurable main-selected thinking.
- **[pi-heartbeat](./packages/pi-heartbeat)** — Runs bounded background shell jobs with tools for starting, checking, and cancelling jobs.
- **[pi-helios](./packages/pi-helios)** — Provides consent-gated Playwright browser and Appium Android-emulator automation plus named Windows-window screenshots.
- **[pi-stateql](./packages/pi-stateql)** — Provides safe stateful database queries, durable result handles, confirmed writes, and bounded web status/history.
- **[pi-discover](./packages/pi-discover)** — Indexes supported source files, provides read-only repository and historical Pi-session search, and coordinates inactive-tool discovery.
- **[pi-scout](./packages/pi-scout)** — Performs bounded repository reconnaissance and fresh-browser isolated public-web research.
- **[pi-spawn](./packages/pi-spawn)** — Creates private resumable subagent threads and first-class child sessions with configurable eligible models and private-agent thinking.
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
- Advisor, Grunt, repository Scout, Continuity, and Memory stay active when configured so their workflow guidance remains visible. Discover keeps `rg`, `fd`, and `search_tools` active while Pylon defers optional browser, Android-emulator, capture, and spawn schemas until discovery selects them; restrictive gates remain authoritative.
- Scout receives bounded verification and checkpoint archaeology from parent session metadata.
- Continuity supports `/plan review`, recording the shared run's `reviewer` phase for Timeline grouping.

Raw verification and Heartbeat logs never cross package events.

## Development

Install workspace dependencies and start the local web app from the repository root. The root `package-lock.json` is the only workspace lockfile; do not generate package-level locks.

```sh
npm run install:packages
npm run web
```

For development without a production build, run `npm run dev --workspace @pylon/web`.

On Windows, use workspace-relative temporary files when passing paths between Git Bash and native Node/Pylon tools; MSYS paths such as `/tmp/...` are not native Windows paths. Stop a running Pylon process or use a separate worktree/copy before `npm ci`, because Windows cannot replace native addons loaded by the active process.
