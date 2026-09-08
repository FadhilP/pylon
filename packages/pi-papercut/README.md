# pi-papercut

A durable, project-scoped backlog for small workflow frictions: undocumented setup, avoidable retries, flaky commands, stale caches, misleading errors, and other non-blocking gotchas. It is not a work log or bug tracker.

## Install

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Package settings are available through Pylon Web.

## Capture and manage papercuts

The `papercut` tool captures by default, lists records, and changes their lifecycle.

```ts
papercut({ message: "README setup omits the build step; the documented test command fails on missing dist files until build runs. Document the prerequisite so the listed steps work on a fresh checkout." });
papercut({ action: "list", status: "open" });
papercut({ action: "resolve", ids: ["a1b2c3d4"], note: "Documented setup and added a regression test." });
papercut({ action: "dismiss", ids: ["a1b2c3d4"], note: "Intentional platform behavior." });
papercut({ action: "reopen", ids: ["a1b2c3d4"] });
```

Capture only observed, actionable friction: name the affected command, file, or workflow, the obstacle and its impact, and a bounded improvement or observable condition for resolution. Write one issue in one or two factual sentences; distinguish suspected causes from observations. An exact fix is not required, but a maintainer must have enough evidence to act. If that evidence is missing, skip capture rather than inventing a cause or investigating just to create a note.

This is not a place for venting, session narratives, ordinary tool limits, intentional safeguards, expected failures, agent/user mistakes, preferences, speculative improvements, product bugs, or already-tracked work. A retry, timeout, or failed command alone does not qualify. Avoid vague complaints such as “setup is frustrating” or “the tool made me retry.” Capture qualifying issues promptly without interrupting the current task.

Messages are capped at 500 characters and likely credentials are rejected. Do not intentionally repeat known entries. Exact normalized duplicates of open records increment their occurrence count; closed records do not prevent a new capture.

IDs are UUIDs or unique prefixes of at least four characters. Resolve/dismiss needs a note. One lifecycle operation can target several IDs; `actions` batches up to 20 `resolve`, `dismiss`, or `reopen` operations, up to 100 distinct records, in one atomic commit. A bad target changes nothing. Mark implementation friction resolved only after suitable verification.

`/papercuts [open|resolved|dismissed|all]` lists records; no argument lists open records. The package does not review the session transcript automatically.

## Settings, storage, and privacy

In Pylon Web, the package has the normal on/off switch and its default-active `papercut` tool can be set to deferred or disabled under **Tool exposure**.

State is private local data at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-papercut/projects/<project-id>.json
```

Pylon Web typically supplies `~/.pylon/agent` as that agent directory. Project identity is the canonical nearest Git root (including worktree `.git` files), or current directory outside Git; moving a checkout creates a separate backlog. Writes use a cross-process lock, atomic replacement, restrictive permissions, a 1,000-record/2 MiB limit, and quarantine malformed state rather than overwriting it. Backlogs are never injected into every prompt; they are listed when needed.
