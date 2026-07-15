# pi-conductor-core

Optional runtime tool coordination for local Pi packages. Packages remain fully functional without Conductor. When installed, they publish tool policies through Pi's event bus; Conductor merges them and becomes the sole active-tool reconciler.

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-conductor-core. Run `/reload` after installation.

## Usage

- `/conductor` shows registered package policies and the latest bounded Guard decision.
- `/conductor doctor` also checks local Pi and Node compatibility, required and optional executables, old locks, quarantined state, configured child-model availability, package tool surfaces, and bounded package health reports without network calls.
- `/conductor tools status` shows baseline tools, effective tools, and whether a restrictive gate is active.
- `/conductor tools enable edit write` enables registered unmanaged tools; `/conductor tools disable edit write` disables them. Policy-managed tools must be changed through their owning package. Active gates remain authoritative, so enabling a blocked tool is deferred until every restrictive gate clears.

Guard remains the independent final safety authority; Conductor never approves or weakens it.

## Scope

- Merges independently enabled tools without lost updates.
- Tracks unmanaged baseline tools separately from package-managed tools.
- Supports explicit baseline tool enable/disable without bypassing package policies.
- Intersects restrictive tool gates fail-closed.
- Validates versioned policy messages and keeps rejection diagnostics.
- Collects versioned metadata-only health report promises with per-reporter timeout, malformed-report isolation, and duplicate-owner warnings.
- Supports policy unregister and removes event listeners during shutdown or reload.
- Lets Continuity planning retain read-only Scout and Advisor tools when enabled.
- Coordinates pi-advisor, pi-grunt, pi-scout, and pi-continuity.
- Falls back to each package's standalone behavior when Conductor is absent.
- Tests real package adapters together.

V1 does not coordinate TUI ownership, context ordering, storage, child processes, or benchmark packages. Those remain out of scope until concrete conflicts appear.

## Protocol

Packages synchronously emit `pi-conductor:tool-policy` during `session_start` and whenever policy changes:

```ts
pi.events.emit("pi-conductor:tool-policy", {
  version: 1,
  kind: "register",
  owner: "pi-example",
  managedTools: ["example_tool"],
  enabledTools: ["example_tool"],
  allowOnly: undefined,
  restoreTools: undefined,
  acknowledge: () => { coordinated = true; },
});
```

`allowOnly` intersects active restrictive gates. When removing a gate, `restoreTools` may provide the package's pre-gate snapshot; Conductor merges unmanaged entries into its baseline only when no other gate remains. No acknowledgement means Conductor is absent, so the package applies its standalone behavior. On `session_shutdown`, emit `{ version: 1, kind: "unregister", owner: "pi-example" }`.

Doctor health collection emits `pi-conductor:health-request`. Reporters must call `respond(reportPromise)` synchronously; Conductor awaits each promise for at most three seconds. Reports contain only `version`, `owner`, `label`, bounded `lines`, and `warning`—never page content, URLs, credentials, or raw logs.
