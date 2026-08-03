# pi-spawn

Persistent child conversations for [Pi](https://pi.dev), exposed through exactly two tools. With Pylon, both tool schemas are deferred by default until `search_tools` selects their capability; without Pylon coordination they remain active normally.

## Tools

### `spawn_agent`

Creates and continues private subagent threads. Private threads are stored outside Pi's normal session index and are available only from the parent session branch that created them.

Actions:

- `create` — requires `prompt`; optionally fixes a concise purpose-based `name`, `model`, `thinking`, `systemPrompt`, `tools`, and `disableSpecialists`.
- `continue` — requires `id` and `prompt`; creation policy cannot change.
- `list` — lists private threads available from the active parent branch.

Use `spawn_agent` for specialized, resumable conversations that should remain private. `systemPrompt` replaces Pi's default system prompt. `tools` is an allowlist; `[]` disables all tools. `disableSpecialists` defaults to `true` and excludes Advisor, Grunt, and Scout. Creation policy is immutable; continue an existing agent when follow-up context matters. Both pi-spawn tools are always excluded from private agents so private threads cannot escape parent-only access by recursively spawning.

### `spawn_session`

Creates, adopts, and continues ordinary Pi sessions.

Actions:

- `create` — requires `prompt`; optional concise purpose-based `name` and `model`. If omitted, the model inherits the parent session's current model. Optional `project` selects another existing project directory.
- `adopt` — requires the exact ID of an existing session in the current or selected project plus `prompt`; claims that session for the active parent and immediately continues it. Optional `project` selects the project to search.
- `continue` — requires `id` and `prompt`; reopens the session in its recorded project.
- `list` — lists sessions available from the active parent branch across projects.

Use `spawn_session` when the child conversation should be inspectable or openable as an ordinary session. Set `project` only when the user explicitly requests work in another project; relative paths resolve from the current project, while omission preserves current-project behavior. Adopt only when the user explicitly asks to resume an existing project session. Only target a project the user trusts: project trust controls input loading, not sandboxing, and spawned sessions run with the user's system permissions. Spawned and adopted sessions use Pi's standard session directory, appear in Pi/Pylon session lists, and load the selected project's normal runtime subject to Pi's project-trust policy. In Pylon, they snapshot the active session-start and before-agent-start hooks; same-project children also expose their parent session in the sidebar. Adoption never accepts a session filesystem path, rejects the active parent and sessions owned by another pi-spawn parent, preserves the adopted session's model, and leaves its existing name and native parent metadata unchanged. Re-adopting a session already owned by the same parent restores access on the current branch without adding another ownership marker. `spawn_session` deliberately exposes no system-prompt, tool, extension, or thinking override.

## Settings

Pylon exposes separate settings for `spawn_agent` and `spawn_session`:

- **Deferred (recommended)** — keeps that schema out of the initial tool set and relies on its description when discovered.
- **Always active** — includes that tool from session start and adds its usage guidelines to the system prompt.

Settings apply to new session runtimes. Both tools default to deferred for prompt-cache efficiency.

## Lifecycle

Activity rows use stable human names selected from a fixed list of scientists; persisted thread titles use the caller's purpose-based name or a normalized prompt preview, never UUID fragments.

Each prompt starts a fresh Pi RPC subprocess, waits for the agent to settle, returns the response and usage to the parent, then exits. The persisted child session is reopened for later prompts. Adoption records ownership before its first prompt, so the claim remains resumable if that prompt fails, is cancelled, or times out.

Calls to different threads may run concurrently. pi-spawn rejects overlapping writes to the same thread within the current Pi/Pylon process. Separate Pi processes cannot share that in-memory lock, so do not adopt, open, or prompt a spawned session while it is active in another Pi process.

The parent must be a persisted session. Session IDs are resolved only through native session metadata plus pi-spawn ownership markers; session filesystem paths are never accepted from the model. `spawn_session` accepts an existing project directory only for `create` and `adopt`.

## Limits

- `PI_SPAWN_TIMEOUT_MS`: per-turn timeout, default 15 minutes, maximum two hours.
- Responses: at most 50 KiB or 2,000 lines.
- Activity: latest 100 child tool events.
- Nested standard-session spawning: maximum process-chain depth 4.

Pi packages and spawned sessions execute with the user's system permissions. A custom subagent system prompt and tool policy are trusted code-execution instructions; review them before use.
