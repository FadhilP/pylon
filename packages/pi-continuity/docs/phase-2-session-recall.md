# Phase 2: Session Recall

## Status

Proposed — begins after Phase 1 establishes a durable handoff boundary contract.

## Goal

Provide bounded, source-addressed recovery of earlier session context without automatically returning discarded history to the model.

Recall is a recovery mechanism for details that deterministic compaction intentionally omits. It is not another memory store.

## Required Contract

- Recall is read-only and explicitly invoked.
- Default results are limited to the current Continuity execution boundary.
- Every result identifies its source session and entry.
- Results are bounded, sanitized, and labeled as historical evidence.
- Recall never creates durable memory, observations, summaries, or session entries.

## Tool Surface

Register one tool, preferably `continuity_recall`, to avoid collisions with other packages.

Suggested input:

```ts
{
  query?: string;
  expand?: string[];
  page?: number;
  scope?: "execution" | "lineage" | "all";
  mode?: "text" | "files" | "touched";
}
```

### Scope

- `execution` — default; entries at or after the current handoff boundary.
- `lineage` — all entries on the active branch, including pre-handoff history.
- `all` — every branch in the current session; explicit use only.

The result must state when a non-default scope was used.

### Modes

- `text` — search sanitized user and assistant text.
- `files` — search or expand explicitly requested file-operation evidence.
- `touched` — list files referenced by read/write/edit operations and their source entries.

Start with literal term matching and bounded regex. Add BM25 ranking only if basic matching produces poor results in real sessions.

## Data Source

Prefer Pi's public `SessionManager` APIs:

- `getBranch()` for active ancestry;
- `getEntries()` for explicit all-branch recall;
- entry IDs and parent IDs for lineage validation.

Do not parse session JSONL directly unless a required historical field is unavailable through the public API.

## Boundary Handling

Use the same boundary resolver introduced in Phase 1.

When the handoff marker has been compacted, recover its identity from Continuity compaction details. If the boundary cannot be proven, fail closed to the currently visible context rather than exposing the whole session.

## Output

Each excerpt should include:

- session ID;
- entry ID;
- role or entry type;
- timestamp when available;
- bounded sanitized content;
- an explicit historical/derived label.

Paginate results and enforce Pi's normal tool-output limits. Expansion should require exact entry IDs rather than unstable display indexes.

## Security

- Exclude thinking blocks by default.
- Redact credential-like strings before indexing and rendering.
- Do not render custom messages owned by unrelated extensions unless explicitly allowlisted.
- Do not expose raw tool arguments or results by default.
- File-content expansion must be explicit, bounded, and sanitized.
- Never follow paths or read current workspace files as a side effect of recall; return only evidence already stored in the session.

## Integration

- Reuse Continuity's secret detection and clipping utilities.
- Reuse the Phase 1 boundary resolver.
- Keep the tool sequential and read-only.
- Do not inject recall results automatically in `before_agent_start` or `context`.
- Do not promote a recalled statement into durable memory without a separate explicit `memory` candidate action and current repository evidence.

## Acceptance Criteria

- Default recall cannot return pre-handoff content.
- Explicit lineage/all scopes are clearly marked.
- Forks and sibling branches return only the requested ancestry or scope.
- Compacted entries remain discoverable through their original source IDs.
- Secret-like content is redacted in searches and expansions.
- Output remains bounded for very large sessions.
- Recall performs no writes and appends no session entries.
- Missing or ephemeral session state returns a clear non-error result.

## Tests

Add focused tests for:

1. default execution-boundary scope;
2. explicit lineage and all-branch scope;
3. post-compaction source lookup;
4. sibling-branch exclusion;
5. malformed or missing parent IDs;
6. secret redaction in prompts, tool arguments, and tool results;
7. custom-message allowlisting;
8. pagination and output clipping;
9. ephemeral sessions with no persisted file;
10. no mutation or memory side effects.

## Non-Goals

- Automatic semantic-memory injection.
- Cross-session or cross-project search.
- Re-reading current files from disk.
- Replacing repository search tools.
- Automatically treating recalled text as current truth.
