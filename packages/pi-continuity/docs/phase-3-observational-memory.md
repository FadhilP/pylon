# Phase 3: Optional Observational Memory

## Status

Deferred and optional. Implement only if Phase 1 compaction plus Phase 2 recall still show measurable context loss.

## Goal

Capture useful session observations that survive repeated compaction without weakening Continuity's curated durable-memory trust model.

Observational memory is derived session context. It is not user memory or project memory.

## Decision Boundary

Do not start this phase based only on feature parity with pi-blackhole. Start it only when session evidence shows that:

- deterministic summaries repeatedly omit important decisions;
- explicit recall is too costly or unreliable in normal work;
- the missing information cannot be represented by active Continuity state.

## Memory Model

Define a separate versioned session record:

```ts
{
  version: 1;
  id: string;
  content: string;
  relevance: "medium" | "high" | "critical";
  sourceEntryIds: string[];
  createdAt: string;
  status: "active" | "dropped";
}
```

Every observation must point to valid source entries on the active lineage. Invalid, missing, or cross-boundary source IDs reject the observation.

## Trust Separation

Observations must never automatically become Continuity `Fact` records.

| Observational memory | Continuity durable memory |
|---|---|
| Session-scoped | User- or project-scoped |
| Model-derived | Explicit candidate action |
| Source entry IDs | Git provenance and evidence hashes |
| Potentially stale | Applicability-classified |
| Removed with session | Retained across sessions |

Promotion requires a separate explicit `memory add` or `memory replace` action and normal Continuity evidence validation.

## Minimal Initial Pipeline

Start with one observer stage only:

1. Trigger after a configurable amount of new, in-boundary transcript.
2. Sanitize and bound input before any model call.
3. Ask for source-addressed observations through a strict tool schema.
4. Validate source IDs and content.
5. Append a versioned custom session entry.
6. Inject only a small relevance-ranked subset during compaction.

Do not initially add separate reflector and dropper agents, persisted cooldown chains, or a second configuration UI. Add those only when measured volume or model failures require them.

## Triggering

- Off by default.
- Never run during explicit planning mode.
- Prefer `agent_settled` or another idle-safe boundary.
- Do not compact or abort an active tool/subagent run.
- Prevent duplicate concurrent observer runs.
- Cancel cleanly on session replacement, reload, or shutdown.

## Sanitization and Privacy

Before sending transcript content to an observer model:

- exclude thinking blocks;
- remove credential-like strings;
- omit unrelated extension custom messages;
- bound tool arguments and tool results;
- omit binary/image payloads;
- restrict entries to the active Continuity boundary;
- disclose which provider/model performs the background call.

Background model calls must be visible, cancellable, and attributable in usage accounting.

## Selection and Retention

Keep retention deterministic initially:

- deduplicate by normalized content and source IDs;
- rank by relevance and recency;
- cap injected observations by token budget;
- mark low-ranked observations dropped rather than deleting their source session entries;
- preserve critical observations unless their sources leave the active lineage.

A model-driven reflector or dropper is unnecessary until deterministic retention demonstrably fails.

## Integration

- Reuse Continuity session lifecycle and singleton ownership.
- Store records as Pi custom entries when practical so branch semantics remain native.
- Reuse Phase 1 boundary metadata and Phase 2 source rendering.
- Keep observational configuration under Continuity's existing settings surface.
- Do not import pi-blackhole's extension bootstrap or vendored UI.

## Acceptance Criteria

- Feature is disabled by default.
- No observation can cite a source before the active handoff.
- Secret-like content is rejected before persistence and model submission.
- Observations never enter durable memory automatically.
- Forks see only observations valid for their active ancestry.
- Repeated observer runs do not duplicate records.
- Session replacement and shutdown leave no running worker or timer.
- Injected observational context remains within a fixed budget.
- Users can inspect and disable the feature without deleting durable Continuity facts.

## Tests

Add focused tests for:

1. opt-in gating;
2. planning-mode suppression;
3. boundary and lineage validation;
4. source-ID hallucination rejection;
5. credential rejection and custom-message filtering;
6. duplicate and concurrent-run suppression;
7. cancellation on reload, fork, and shutdown;
8. deterministic retention and token caps;
9. branch-local visibility;
10. strict separation from durable memory candidates.

## Non-Goals

- Automatic cross-session memory.
- Automatic promotion to project or user facts.
- Three-agent observer/reflector/dropper parity.
- Provider fallback and cooldown infrastructure before it is needed.
- Mid-run compaction or automatic task resumption.
