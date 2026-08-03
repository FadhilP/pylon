# pylon-core

Optional runtime tool coordination for local Pi packages. Packages remain fully functional without Pylon. When installed, they publish tool policies through Pi's event bus; Pylon merges them and becomes the sole active-tool reconciler.

Pylon Web always loads pylon-core and does not expose a disable control because session coordination, delegated-run naming, and workspace reporting depend on it.

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pylon-core. Run `/reload` after installation.

## End-User Commands

- `/pylon` shows registered package policies and the latest bounded Guard decision.
- `/pylon doctor` also checks local Pi and Node compatibility, required and optional executables, old locks, quarantined state, configured child-model availability, package tool surfaces, and bounded package health reports without network calls.
- `/pylon tools status` shows baseline tools, effective tools, and whether a restrictive gate is active.
- `/pylon tools enable edit write` enables registered unmanaged tools; `/pylon tools disable edit write` disables them. Policy-managed tools must be changed through their owning package. Active gates remain authoritative, so enabling a blocked tool is deferred until every restrictive gate clears.
- `/tokens` reports estimated payload tokens for every built-in and custom tool used on the current session branch. It also attributes child-model usage and cost to Advisor, Grunt, Scout, and Timeline; reports context-section counts and SHA-256 hashes (never raw prompts); tracks cache use, retries, repeated calls, Sieve recalls, verification outcomes; and totals main plus child model cost.

Guard remains the independent final safety authority; Pylon never approves or weakens it.

## Library API

`pylon-core/token-meter` exports the side-effect-free `meterFromBranch()` helper and aggregate token-meter types for packages that need the same branch-scoped usage accounting as `/tokens`.

## Runtime Behavior

- Merges independently enabled tools without lost updates.
- Keeps optional browser and capture tools inactive until pi-discover selects them; configured workflow tools remain active so their guidance stays visible.
- Replaces bounded discovery selections without bypassing restrictive gates.
- Tracks unmanaged baseline tools separately from package-managed tools.
- Supports explicit baseline tool enable/disable without bypassing package policies.
- Intersects restrictive tool gates fail-closed.
- Validates versioned policy messages and keeps rejection diagnostics.
- Collects versioned metadata-only health report promises with per-reporter timeout, malformed-report isolation, and duplicate-owner warnings.
- Supports policy unregister and removes event listeners during shutdown or reload.
- Lets Continuity planning retain read-only Scout and Advisor tools when enabled.
- Coordinates pi-advisor, pi-grunt, pi-helios, pi-scout, and pi-continuity.
- Fingerprints shell-driven worktree changes once per model turn for shared Continuity and Timeline consumption.
- Provides opt-in Git workspace primitives for platform hosts: dirty-state baselines, Pylon-owned linked worktrees, confined file reads, bounded diffs, and reversible checkout-state moves. Importing the extension never creates a worktree.
- Persists bounded, path-only changed-file summaries in Pi session entries for platform clients.
- Falls back to each package's standalone behavior when Pylon is absent.
- Tests real package adapters together.
- Tracks per-tool payloads plus privacy-safe package, context, cache, retry, recall, verification, and cost telemetry. Only validated Timeline aggregates are added to session data; prompts and evidence are never stored.

V1 does not coordinate TUI ownership, context ordering, general package storage, child processes, or benchmark packages. Durable storage is limited to bounded telemetry and changed-file summaries.

## Package-Author Protocol

### Registration

Packages synchronously emit `pylon:tool-policy` during `session_start` and whenever policy changes:

```ts
pi.events.emit("pylon:tool-policy", {
  version: 1,
  kind: "register",
  owner: "pi-example",
  managedTools: ["example_tool"],
  enabledTools: ["example_tool"],
  deferredTools: ["example_tool"], // optional: available through search_tools
  deferredToolUsage: { example_tool: "inspect example project data" }, // optional compact discovery phrase
  allowOnly: undefined,
  restoreTools: undefined,
  acknowledge: () => { coordinated = true; },
});
```

### Deferred Tools and Gates

`deferredTools` must be a subset of `enabledTools`. `deferredToolUsage` optionally maps deferred tool names to concise one-line capability phrases (maximum 120 characters) used for discovery matching and model guidance; its keys must be deferred tools. If multiple owners advertise different phrases for the same tool, Pylon omits that ambiguous usage. Deferred tools stay inactive until selected through the synchronous `pylon:tool-discovery` capability used by pi-discover. The capability exposes the currently eligible names and usage catalog. Each selection replaces the previous one and is capped at six tools. `allowOnly` still intersects the result, so planning and safety gates remain authoritative. When removing a gate, `restoreTools` may provide the package's pre-gate snapshot; Pylon merges unmanaged entries into its baseline only when no other gate remains. No acknowledgement means Pylon is absent, so the package applies its standalone behavior. On `session_shutdown`, emit `{ version: 1, kind: "unregister", owner: "pi-example" }`.

### Health Reports

Doctor health collection emits `pylon:health-request`. Reporters must call `respond(reportPromise)` synchronously; Pylon awaits each promise for at most three seconds. Reports contain only `version`, `owner`, `label`, bounded `lines`, and `warning`—never page content, URLs, credentials, or raw logs.
