# pylon-core

Optional runtime coordination for local Pi packages. Packages work standalone without it; when present, they publish policies through Pi's event bus and Pylon becomes the sole active-tool reconciler. Pylon Web always loads core because session coordination, delegated-run naming, and workspace reporting depend on it.

## Install and commands

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Core package settings are available through Pylon Web.

| Command or tool | Use |
| --- | --- |
| `/pylon` or `/pylon status` | Show health, tools, policies, rejected updates, and latest bounded Guard decision |
| `/pylon doctor` | Check local Pi/Node, executables, locks, state, child models, tool surfaces, and bounded health reports; never uses network |
| `/pylon tools status` | Show baseline/effective tools and restrictive gates |
| `/pylon tools enable …` / `disable …` | Change registered unmanaged tools; package-managed tools stay owned by their package |
| `/tokens` / `/tokens all` | Report branch-scoped tool payload and main/child usage/cost summary |
| `pylon_docs` | List or read shipped Pylon, Pylon Web, and package documentation with Web/TUI-aware guidance |

Gates remain authoritative: enabling a blocked baseline tool waits for gates to clear. Guard is the independent final safety authority; Pylon never approves or weakens it. In the full Pylon bundle, `pylon_docs` is deferred and can be activated through `search_tools`, keeping documentation out of the normal system prompt and tool context. Pylon Web marks the current host so the tool prioritizes panels, Inspector references, and Settings actions; Pi TUI prioritizes tools and slash commands. A standalone `pylon-core` install exposes its local README directly.

## Numbered line edits

Revision-guarded numbered edits are on by default. For models whose advertised base/tier output prices are all below three times input prices, Pylon leaves Pi native `read`/`edit`; otherwise it uses numbered edits. Missing/zero pricing enables numbered edits. The automatic per-session choice is reevaluated on model change; disable the setting to always leave native tools unchanged.

Numbered `read` returns absolute lines and a compact version tag backed by SHA-256. `edit` accepts complete displayed numbered lines only when the tag matches. Disjoint operations validate against one snapshot and save once through Pi's per-file queue. Normal successful saves return the new tag; surrounding context is returned only when another process changed the file while saving. Settings live at `<agent-dir>/pylon-core/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden. Each field reports when it applies; reload other Pi clients when required.

## Coordination behavior

Core merges independently enabled tools, keeps baseline tools separate from package-managed tools, applies restrictive gates by fail-closed intersection, and validates/version-diagnoses policy messages. Discovery can select up to six deferred tools without bypassing gates. It coordinates Advisor, Grunt, Helios, Scout, and Continuity; allows Continuity planning to retain enabled read-only Scout/Advisor; shares one shell worktree fingerprint per turn for Continuity/Timeline; and falls back to each package's standalone behavior when absent.

It collects bounded metadata-only health reports, unregisters policies/listeners at shutdown, persists only bounded path-only changed-file summaries and telemetry, and never stores prompts/evidence. Opt-in Git helpers provide dirty baselines, Pylon-owned linked worktrees, confined reads, bounded diffs, and reversible checkout-state moves; loading core never creates a worktree. `pylon-core/token-meter` exports side-effect-free `meterFromBranch()` and aggregate token-meter types.

## Advanced: package-author protocol

### Register and acknowledge

On `session_start`, and whenever policy changes, synchronously emit `pylon:tool-policy`:

```ts
pi.events.emit("pylon:tool-policy", {
  version: 1,
  kind: "register",
  owner: "pi-example",
  managedTools: ["example_tool"],
  enabledTools: ["example_tool"],
  deferredTools: ["example_tool"], // optional
  deferredToolUsage: { example_tool: "inspect example project data" }, // optional
  allowOnly: undefined,
  restoreTools: undefined,
  acknowledge: () => {
    coordinated = true;
  },
});
```

The synchronous acknowledgement means Pylon is coordinating. Without it, apply the package's standalone behavior. On `session_shutdown`, emit `{ version: 1, kind: "unregister", owner: "pi-example" }` and remove listeners.

### Deferred tools and gates

`deferredTools` must be a subset of `enabledTools`. `deferredToolUsage` maps only deferred names to one-line phrases of at most 120 characters. Conflicting phrases for one tool are omitted. Deferred tools remain inactive until pi-discover uses the synchronous `pylon:tool-discovery` capability; it exposes eligible names/usage, replaces the prior selection, and caps selection at six. `allowOnly` still intersects selected tools, so planning/safety gates win. When removing a gate, `restoreTools` may carry the pre-gate snapshot; Pylon merges unmanaged entries into baseline only when no other gate remains.

### Health reports and privacy

Doctor emits `pylon:health-request`. A reporter must synchronously call `respond(reportPromise)`; Pylon waits at most three seconds per promise and isolates malformed reports. Reports contain only `version`, `owner`, `label`, bounded `lines`, and `warning`. Never include page content, URLs, credentials, raw logs, prompts, or evidence.
