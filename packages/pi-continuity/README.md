# pi-continuity

Opt-in planning, visible todos, durable workspace memory, bounded session recall, and deterministic compaction for Pi. Continuity can propose and update durable memory; `continuity_recall` itself is read-only.

## Install and availability

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Continuity works standalone; its package settings are available through Pylon Web.

| Command | Use |
| --- | --- |
| `/plan [status|start [goal]|approve|approve-current|changes <feedback>|review|cancel|help]` | Start and manage explicit planning |
| `/continuity [status|set <role> <provider/model[:thinking]>|select <role>|reset <role>|help]` | Configure planner, executor, and reviewers |
| `/todos [help]` | Show stored todos |
| `/memory [status|list [user|project]|edit <user|project> <id>|forget <user|project> [id]|owners|backups|migrate|rollback|activation <on|off>|help]` | Manage durable memory |

Tools are `continuity_recall`, `continuity_update`, and `memory`. The memory tool lists notes and batches up to two proposed additions, replacements, or removals. In Pylon it is deferred until a Memory Reviewer is configured, then active by default; explicit tool exposure still wins.

## Planning and todos

Planning starts only with `/plan start`; words in chat and `continuity_update set_plan` cannot activate its gate. Outside plan mode, Continuity selectively records risky/long multi-phase work, handoffs, and likely blockers. A plan normally creates 2–4 outcome-level internal todos (up to 12); straightforward reads and small fixes may need none.

During explicit planning, only read-oriented tools, `continuity_update`, memory listing, `repo_scout`, and `advisor` are allowed. Approval restores the prior tool snapshot, including mutation tools, subject to other gates. `/plan approve` creates a persisted execution boundary and gives the executor the approved structured handoff plus later messages; `/plan approve-current` keeps current context. If a configured model is unavailable, the workflow stops rather than silently switching models. TUI and Pylon Web offer an untimed revision review; print/JSON use commands.

Todos remain visible while the run works and clear when it settles; descriptions are limited to 120 characters and `/todos` remains available. Replanning preserves matching progress. Clarification asks one concrete decision at a safe checkpoint; TUI/RPC show options, while print/JSON asks in prose and blocks further tools for that run.

Verify is a completion gate after mutation-capable work. Run it in a tool-only turn, wait, then provide one evidence-aware final response. Passing Verify can complete a sole verification todo. Failed, cancelled, stale, errored, or missing verification leaves work recoverable; `clean` or `no_checks` needs an explicit tool-only `allowUnverified` acknowledgement before the final response. Pylon shares exact Bash worktree comparison with Guard/Timeline; standalone Continuity compares per call. Heartbeat jobs with a valid `todoId` update that todo.

## Compaction and recall

Continuity intercepts manual and automatic compaction and always creates a deterministic compact Markdown result. Active Work retains the latest request, goal, plan, todos, constraints, verification, and best-effort file activity; other sessions use bounded stable transcript extraction. By default it keeps about 25,000 recent raw tokens. **Continuity retained tokens** in Pylon Web settings accepts 1,000–50,000 and overrides Pi's keep-recent setting only for Continuity compactions. Canonical output is capped at 20,000 characters plus up to 4,000 supplemental characters.

An optional Compaction Reviewer is disabled until configured with `/continuity set compaction-reviewer provider/model[:thinking]` or Pylon settings. It receives a bounded credential-redacted draft/discard packet and may return up to six validated exact excerpts; it cannot change canonical Work, verification, order, or cut. Failure falls back to deterministic compaction. `/compact <instructions>` is reviewer focus and requires that reviewer; plain `/compact` does not. Review adds provider cost/privacy exposure; telemetry contains bounded model/timing/usage/counts, never transcript text, paths, quotes, or source IDs.

`continuity_recall` searches bounded historical evidence without reading files or creating memory/session entries. Default scope is current execution; explicit lineage includes active ancestors, all includes validated sibling branches, and `project_sessions` searches validated active branches of other persisted sessions for the same project owner. Historical results are untrusted and may be stale. It returns eight matches plus a lookahead, excludes thinking and normal tool payloads, and redacts credentials best-effort. `tools` mode searches sanitized tool names/arguments and expands an exact in-scope result only. For an exact historical session ID, use Discover's `search_sessions` with `sessionId`, not recall query text.

## Durable memory

Memory V6 is a future-facing notebook, separate from Active Work and recall. Notes are canonical “When X, do Y” rules with source, disposition, authority, revision, and timestamps. Data is atomically stored with mode `0600` at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-continuity/memory-v6/state.json
```
Pylon Web uses `~/.pylon/agent` as `<agent-dir>` by default. Standalone Pi uses its host agent directory, normally `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides the host that sets it.

A rebuildable index sits beside it. Storage allows 1,000 notes per owner and 2 MiB total; writes fail visibly instead of evicting notes. Activation is allow-none and event-driven: only eligible notes with valid trigger contracts may queue one advisory message. It never blocks or transforms a tool. Prompt similarity never activates a rule.

Configure a dedicated Memory Reviewer with `/continuity set memory-reviewer provider/model[:thinking]` or Pylon settings; there is no fallback. User proposals require an exact active-branch quote; project proposals require bounded repository ranges. Preflight limits evidence to three ranges/120 lines per proposal, rejects secrets and strong duplicates, and reviewer output is strictly validated. A proposal becomes durable only after preflight, reviewer acceptance, post-review validation, settlement, and any required current Verify result. Provider/credential, malformed, stale, branch-change, or evidence failures write nothing.

Users can directly edit/delete global user and current-project notes in interactive Pi and Pylon Web using ID+revision compare-and-set; owners are server-derived and global deletion requires confirmation. V5→V6 startup migration is restartable and preserves legacy notes as archival; V4 migration remains explicit through `/memory migrate`. `/memory backups` lists backups and `/memory rollback` restores the pre-migration V6 notebook only while its activation revision is current.

## Safety and limitations

Reviewers receive bounded redacted material, but redaction is not proof of secrecy and reviewer calls cost money. Extensions run with your user permissions. Print and JSON modes use prose clarification rather than structured dialogs. Continuity has no cloud sync; memory is local to the configured agent directory.