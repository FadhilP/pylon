# pi-papercut

Durable, project-scoped capture of the small workflow frictions that make a repository harder to work in.

Papercuts are non-blocking problems such as avoidable tool retries, undocumented setup steps, flaky commands, stale caches, misleading errors, and non-obvious gotchas. They are distinct from completed-work logs and from real bugs or tracked work.

## Installation

pi-papercut is included in the Pylon bundle:

```sh
pi install git:github.com/FadhilP/pylon
```

Run `/reload` after installation.

## Tools

### `papercut`

The model calls the capture-only tool in the moment with one or two sentences describing what it was doing, what got in the way, and optionally a tentative cause or improvement. Capture does not interrupt or expand the current task.

```ts
papercut({
  message: "Running setup required an undocumented retry; the prerequisite should be documented."
})
```

Exact normalized duplicates of open records increment their occurrence count instead of creating another record. Closed records do not suppress a new occurrence. Messages are capped at 500 characters and likely credentials are rejected.

### `papercuts`

The management tool lists or atomically updates the backlog:

```ts
papercuts({ action: "list", status: "open" })
papercuts({ action: "resolve", ids: ["a1b2c3d4"], note: "Documented setup and added a regression test." })
papercuts({ action: "dismiss", ids: ["a1b2c3d4"], note: "Intentional platform behavior." })
papercuts({ action: "reopen", ids: ["a1b2c3d4"] })
```

IDs may be full UUIDs or unique prefixes of at least four characters. Resolution requires a note. Batch updates validate every ID before writing, so a bad target changes nothing. Implementation-related papercuts should be marked resolved only after suitable verification.

## Commands

```text
/papercuts [open|resolved|dismissed|all]
/papercut <message>
/papercut resolve <id> <resolution>
/papercut dismiss <id> [reason]
/papercut reopen <id>
```

Session transcript review is intentionally not included.

## Pylon Web settings

The package appears in **Settings → Packages** with the standard package on/off switch. Its `papercut` and `papercuts` tools are published under **Tool exposure**, where each can inherit the default or be set to active, deferred, or disabled.

## Storage and privacy

State is stored privately beneath the host Pi agent directory:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-papercut/projects/<project-id>.json
```

Pylon Web therefore uses `~/.pylon/agent` through its configured `PI_CODING_AGENT_DIR`. The package uses Pi's `getAgentDir()` rather than hard-coding either location.

Project identity is based on the canonical path of the nearest Git root (`.git` may be a directory or worktree file); outside Git it uses the current working directory. The identity is checkout-path scoped, so moving a checkout starts a separate backlog. State writes use a cross-process lock, atomic replacement, restrictive file permissions, a 1,000-record limit, and a 2 MiB total limit. Malformed state is quarantined instead of overwritten.

No papercut backlog is injected into every prompt. The model lists it only when needed, such as when the user asks to resolve stored papercuts.
