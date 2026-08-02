# Phase 1: Boundary-Aware Deterministic Compaction

## Status

Proposed — highest priority.

## Goal

Replace Pi's lossy free-form compaction summary with a deterministic Continuity-owned compaction path that never loses the active request or crosses an execution handoff boundary.

## Problem

Pi's default compaction can summarize the wrong user request as the current task. In long tool-running turns, the latest user message may fall before Pi's retained tail and survive only through an inaccurate generated summary.

Continuity also creates an execution boundary when a plan is approved. A compactor that reads the raw branch without respecting `pi-continuity-handoff` can reintroduce planning messages that Continuity intentionally removed from executor context.

## Required Contract

After compaction, the model must receive:

1. The latest in-scope user request verbatim.
2. The active Continuity goal, current todo, blockers, constraints, and next action.
3. Recent assistant and tool activity when it fits the retention budget.
4. A deterministic summary of older in-scope history.
5. No content from before the active Continuity handoff unless explicitly requested later through recall.

Repository evidence and direct user instructions remain authoritative over any summary.

## Design

### 1. Resolve the active boundary

Use the latest valid `pi-continuity-handoff` on the active branch. After that marker has itself been compacted, recover the boundary from Continuity metadata stored in the latest compaction details.

The boundary identity should include the Continuity `runId` and `timelineId`. Do not infer a boundary from timestamps or message text.

### 2. Build an exact current-task anchor

Create a bounded `[Current Task]` section containing:

- the latest user message after the active boundary, copied verbatim;
- the active Continuity goal;
- the current todo ID, status, and text;
- blockers and next action when present;
- at most the execution-relevant constraints already selected by Continuity.

This section is assembled mechanically. It is never generated or paraphrased by an LLM.

### 3. Choose the retained tail

Prefer retaining the complete turn beginning with the latest in-scope user message.

If that turn fits the configured retention budget, set the retained boundary to that user entry and keep every following message needed to preserve assistant/tool-call ordering.

If the current turn alone exceeds the budget, use Pi's valid split-turn cut so tool calls and results stay paired. Keep the exact `[Current Task]` section in the summary and deterministically summarize only the older prefix of the oversized turn.

Start with Pi's normal retained-tail budget. Do not adopt Blackhole's aggressive `minimal` cut until real usage demonstrates a need.

### 4. Summarize older history deterministically

Port only the isolated structural compaction pipeline needed to extract:

- goals and explicit scope changes;
- files read or modified;
- commits;
- unresolved errors and blockers;
- user preferences;
- a bounded recent transcript brief.

Treat these sections as derived context, not source-of-truth state.

### 5. Handle previous summaries safely

Merge a previous summary only when its Continuity boundary identity matches the current boundary.

Never merge:

- a summary created before the current handoff;
- a summary from another run or branch;
- observational-memory content into durable Continuity facts;
- an unversioned summary whose boundary cannot be proven.

### 6. Persist compaction metadata

Store versioned details with the compaction entry:

```ts
{
  type: "pi-continuity-compaction",
  version: 1,
  runId: string,
  timelineId: string,
  handoffEntryId?: string,
  currentTaskEntryId?: string,
  sourceEntryCount: number
}
```

This metadata must be sufficient to reconstruct the boundary after older custom messages leave model context.

## Integration

- Continuity remains the only lifecycle registrar.
- Register one `session_before_compact` handler inside `pi-continuity`.
- Let Pi continue deciding when automatic compaction is needed initially.
- Add a manual Continuity command only if the built-in `/compact` path cannot expose the required behavior.
- Do not import pi-blackhole's extension entry point, background workers, commands, or config UI.

## Security

- Never include redacted thinking.
- Run current secret detection over generated summary sections.
- Avoid copying complete tool arguments or tool results into the summary.
- Include only bounded file paths and short error excerpts.

## Acceptance Criteria

- The latest in-scope user request appears verbatim after every compaction.
- Active goal and current todo survive compaction without paraphrasing.
- Pre-handoff planning messages cannot reappear in executor context.
- A previous summary from another boundary is rejected.
- Tool calls are never retained without their corresponding results, or vice versa.
- Repeated compaction does not duplicate task anchors or recall notices.
- Forks and sibling branches use only their active ancestry.
- Empty, single-user, oversized-turn, and missing-marker cases degrade safely.

## Tests

Add focused tests for:

1. latest-user preservation;
2. approved-plan handoff isolation;
3. repeated compaction under one run;
4. compaction before and after a new handoff;
5. split turns with tool calls and results;
6. forks, sibling branches, and missing entry IDs;
7. credential-like text in prompts and tool output;
8. bounded output size.

## Non-Goals

- Session-history search — Phase 2.
- Background observations or reflections — Phase 3.
- Custom model fallback chains.
- A second settings UI.
- Replacing Continuity planning, todos, verification, or durable memory.
