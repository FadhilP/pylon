# pi-spawn

Private persistent subagent threads and ordinary spawned Pi sessions, exposed through exactly `spawn_agent` and `spawn_session`. With Pylon both schemas are deferred until `search_tools` discovers them; without Pylon they remain active.

## Install

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Pylon Web exposes package settings for new child availability, model eligibility, thinking levels, timeouts, and prompt defaults.


## Private agents: `spawn_agent`

Use private agents for specialized, resumable work that should remain accessible only to the creating parent branch. Threads live outside Pi's normal session index.

| Action | Use |
| --- | --- |
| `create` | Start with `prompt`; optional purpose-based `name`, `model`, `thinking`, `systemPrompt`, `tools`, `disableSpecialists` |
| `continue` | Continue `id` with `prompt` under immutable creation policy |
| `status` / `cancel` | Inspect/collect or stop a background `runId` |
| `recent` | Read bounded active transcript messages without waking it |
| `list` | List private threads available from this branch |

Calls are synchronous by default. `background: true` returns `id`/`runId` immediately for independent work. Overlap is `busy` unless a background continuation also sets `queue: true`, which creates a parent-runtime FIFO job. Background work and queues are runtime-local, reject dialogs, and cancel at session shutdown. `recent` defaults to 8 messages/800 characters, permits at most 50/2,000, and caps total output at 12,000 characters.

`systemPrompt` replaces Pi's default prompt; `tools` is an allowlist and `[]` disables tools. `disableSpecialists` defaults true, excluding Advisor, Grunt, and Scout. pi-spawn is always excluded from private agents, preventing recursive escape. Creation policy cannot change later.

## Ordinary sessions: `spawn_session`

Use ordinary sessions when the conversation should be inspectable/openable in Pi or Pylon.

| Action | Use |
| --- | --- |
| `create` | Start with `prompt`; optional purpose name, model, and existing `project` |
| `adopt` | Claim one exact existing session ID and immediately continue it |
| `continue` | Reopen recorded-project session with `id` and `prompt` |
| `status` / `cancel` / `list` | Manage background runs or visible sessions |

Create/adopt/continue have the same synchronous/background/queue behavior as private agents. Omitted model inherits the parent's current model. Set `project` only on explicit user request; relative paths resolve from the current project. Adopt only an explicitly requested trusted project session. It rejects filesystem paths, the active parent, and sessions owned by another pi-spawn parent; it preserves adopted model/name/native parent metadata. `spawn_session` intentionally has no system-prompt, tool, extension, or thinking override.

Spawned/adopted sessions use Pi's normal session storage and project-trust policy; trust controls input loading, not sandboxing. In Pylon, children snapshot active session-start/before-agent-start hooks and same-project children expose their parent in the sidebar.

## Pylon settings, lifecycle, and limits

Pylon Web package settings control each tool independently: **Deferred** (recommended) or **Always active**. They also restrict authenticated session-scoped models for new children; without an allowlist all are eligible, and an omitted excluded parent model uses the first eligible model. Private-agent thinking has a separate nonempty allowlist. These settings apply to new runtimes/children; existing threads continue.
Configuration is stored at `<agent-dir>/pi-spawn/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

Each foreground prompt starts a fresh Pi RPC subprocess and returns response/usage on settlement; background does the same later. `status`/`cancel` collect a terminal response once. Foreground dialogs proxy through parent UI; unavailable, malformed, unsupported, and background dialogs cancel rather than hang. Different threads can run concurrently, but do not concurrently write shared paths; separate Pi processes do not share locks/queues.

The parent must be persisted. Limits: no default turn timeout (`PI_SPAWN_TIMEOUT_MS` may set up to two hours), 20 retained background terminal results, 50 KiB/2,000-line responses, bounded per-call activity, and standard-session process-chain depth 4. Reload/session replacement/exit cancels active/queued work. Packages and children have your system permissions; custom prompts/tool policies are trusted code-execution instructions.