# pi-spawn

Persistent child conversations for [Pi](https://pi.dev), exposed through exactly two tools.

## Tools

### `spawn_agent`

Creates and continues private subagent threads. Private threads are stored outside Pi's normal session index and are available only from the parent session branch that created them.

Actions:

- `create` — requires `prompt`; optionally fixes `name`, `model`, `thinking`, `systemPrompt`, `tools`, and `disableSpecialists`.
- `continue` — requires `id` and `prompt`; creation policy cannot change.
- `list` — lists private threads available from the active parent branch.

`systemPrompt` replaces Pi's default system prompt. `tools` is an allowlist; `[]` disables all tools. `disableSpecialists` defaults to `true` and excludes Advisor, Grunt, and Scout. Both pi-spawn tools are always excluded from private agents so private threads cannot escape parent-only access by recursively spawning.

### `spawn_session`

Creates, adopts, and continues ordinary Pi sessions.

Actions:

- `create` — requires `prompt`; optional `name`.
- `adopt` — requires the exact ID of an existing session in the current project plus `prompt`; claims that session for the active parent and immediately continues it.
- `continue` — requires `id` and `prompt`.
- `list` — lists sessions available from the active parent branch.

Spawned and adopted sessions use Pi's standard session directory, appear in Pi/Pylon session lists, and load the normal project runtime. Adoption never accepts a filesystem path, rejects the active parent and sessions owned by another pi-spawn parent, and leaves the existing session name and native parent metadata unchanged. Re-adopting a session already owned by the same parent restores access on the current branch without adding another ownership marker. `spawn_session` deliberately exposes no system-prompt, tool, extension, model, or thinking override.

## Lifecycle

Each prompt starts a fresh Pi RPC subprocess, waits for the agent to settle, returns the response and usage to the parent, then exits. The persisted child session is reopened for later prompts. Adoption records ownership before its first prompt, so the claim remains resumable if that prompt fails, is cancelled, or times out.

Calls to different threads may run concurrently. pi-spawn rejects overlapping writes to the same thread within the current Pi/Pylon process. Separate Pi processes cannot share that in-memory lock, so do not adopt, open, or prompt a spawned session while it is active in another Pi process.

The parent must be a persisted session. IDs are resolved only through native session metadata plus pi-spawn ownership markers; filesystem paths are never accepted from the model.

## Limits

- `PI_SPAWN_TIMEOUT_MS`: per-turn timeout, default 15 minutes, maximum two hours.
- Responses: at most 50 KiB or 2,000 lines.
- Activity: latest 100 child tool events.
- Nested standard-session spawning: maximum process-chain depth 4.

Pi packages and spawned sessions execute with the user's system permissions. A custom subagent system prompt and tool policy are trusted code-execution instructions; review them before use.
