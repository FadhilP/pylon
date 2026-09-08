# Workspace Files Phase 3: Filesystem Watchers

## Status

Future design only. Phase 3 is intentionally not implemented yet.

## Existing implementation context

### Phase 1: stale-while-revalidate

The Files panel and expanded workspace keep their previous inventory visible while a newer revision loads. Client caches are retained across workspace revision events and reused only when the session generation matches; unchanged revisions avoid unnecessary reloads. Failed or background reconciliation does not blank the visible tree.

### Phase 2: agent-touched incremental refresh

Pylon collects bounded exact paths from successful `write`/`edit` tools and validated worktree summaries. The core path-scoped collector resolves each path through registered submodules and authoritatively computes its current baseline-relative state. The server patches additions, modifications, clean reversions, and safe removals into its canonical inventory. Ambiguous tools, bulk changes, invalid paths, submodule topology changes, path overflow, expired caches, and unsafe truncated-inventory removals fall back to a full background reconciliation.

Phase 2 intentionally has no filesystem watcher, so edits made outside Pylon remain eventually consistent through reconciliation. Phase 3 should reuse the same path-scoped collector and fallback rules rather than introducing separate status logic.

## Goal

Keep the Files workspace current for edits made outside Pylon without rebuilding the complete workspace inventory. Reuse the Phase 2 path-scoped collector so watcher events are hints, never authoritative file metadata.

## Architecture

1. Start one watcher coordinator for the registered workspace.
2. Watch the superproject and every initialized registered submodule discovered from Git gitlinks.
3. Convert filesystem events into canonical workspace-relative paths.
4. Debounce and deduplicate paths into bounded batches.
5. Pass exact file batches to the existing path-scoped collector.
6. Atomically patch the canonical server inventory and publish a versioned delta.
7. Keep the previous client tree visible while applying deltas or reconciling.

The watcher must not calculate Git status, baseline state, or submodule ownership itself. Those remain responsibilities of the core collector.

## Watcher lifecycle

- Start after a session workspace becomes ready.
- Rebind after checkout/worktree handoff or session replacement.
- Add/remove child watchers when registered submodules are initialized, removed, or moved.
- Stop all watchers when a runtime sleeps or is disposed.
- Perform an initial full inventory before accepting deltas.

## Event handling

Coalesce common editor write patterns such as temporary-file creation followed by rename. Exact file create, modify, and delete events can use path-scoped collection. Directory creation/deletion, recursive changes, rename pairs that cannot be matched, watcher overflow, and Git topology changes must request background reconciliation.

Suggested batch limits:

- 100 exact paths per debounce window.
- 100–250 ms debounce during ordinary editing.
- One serialized update per workspace inventory key.

Exceeding a limit must set `reconcileRequired`; events must never be silently discarded.

## Delta contract

A future server-to-client event should include:

```ts
interface WorkspaceInventoryDelta {
  sessionGeneration: number;
  baseVersion: number;
  version: number;
  revision: string;
  upserted: WorkspaceFileReadModel[];
  removed: string[];
  reconcileRequired?: boolean;
}
```

Clients apply only contiguous deltas for the active session generation and matching base version. A gap retains stale data and schedules reconciliation.

## Reconciliation

A full background scan remains necessary after:

- watcher overflow or backend errors;
- branch checkout, reset, merge, rebase, or large rename;
- registered-submodule topology or initialization changes;
- directory-wide operations, extraction, or generated trees;
- truncated-inventory deletions where the next cutoff entry is unknown;
- runtime sleep/wake or detected delta gaps.

Reconciliation must use stale-while-revalidate: never clear the visible tree before a successful replacement inventory is ready.

## Security

- Canonicalize every watched root and require it beneath the registered workspace.
- Watch only the superproject and registered Git submodules; never arbitrary nested repositories.
- Reject absolute, traversal, malformed, and overlong event paths.
- Do not follow symlinked directories outside the workspace.
- Treat `.git` internals as topology signals only and never expose them as workspace files.

## Cross-platform considerations

Node watcher behavior differs across Windows, macOS, and Linux. Before choosing native `fs.watch` or a dependency, validate recursive support, rename semantics, overflow reporting, network filesystems, case-only renames, and resource limits on all supported platforms. No watcher dependency should be added without this evaluation.

## Required tests

- create, modify, delete, and atomic-save rename;
- rapid duplicate-event coalescing;
- nested registered-submodule files;
- submodule initialize/remove/checkout changes;
- directory deletion and bulk generation fallback;
- symlink and workspace-escape rejection;
- watcher overflow and restart;
- stale tree retention during failed reconciliation;
- out-of-order and missing delta versions;
- Windows path casing and separators;
- runtime handoff, sleep, wake, replacement, and disposal.
