# Workspace Files Phase 3: Filesystem Watchers

## Status

Future design only. Phase 3 is intentionally not implemented yet.

This revision proposes low-risk improvements to scheduling, freshness, recovery, and rollout. The existing implementation context below is preserved from the supplied plan; repository APIs, the supported runtime matrix, and performance have not been independently verified. Suggested timing values are starting points for validation, not measured results or service guarantees.

## Existing implementation context

### Phase 1: stale-while-revalidate

The Files panel and expanded workspace keep their previous inventory visible while a newer revision loads. Client caches are retained across workspace revision events and reused only when the session generation matches; unchanged revisions avoid unnecessary reloads. Failed or background reconciliation does not blank the visible tree.

### Phase 2: agent-touched incremental refresh

Pylon collects bounded exact paths from successful `write`/`edit` tools and validated worktree summaries. The core path-scoped collector resolves each path through registered submodules and authoritatively computes its current baseline-relative state. The server patches additions, modifications, clean reversions, and safe removals into its canonical inventory. Ambiguous tools, bulk changes, invalid paths, submodule topology changes, path overflow, expired caches, and unsafe truncated-inventory removals fall back to a full background reconciliation.

Phase 2 intentionally has no filesystem watcher, so edits made outside Pylon remain eventually consistent through reconciliation. Phase 3 should reuse the same path-scoped collector and fallback rules rather than introducing separate status logic.

## Goal

Keep the Files workspace current for edits made outside Pylon without rebuilding the complete workspace inventory. Reuse the Phase 2 path-scoped collector so watcher events are hints, never authoritative file metadata.

Prioritize fewer redundant collections and full scans, bounded refresh delay during continuous editing, and reliable recovery without clearing the visible tree. Do not expand this phase into a separate Git-status engine, rename-inference system, content-hashing service, persistent event log, or per-file polling service.

## Architecture

1. Start one watcher coordinator for the registered workspace, shared by all clients of the same workspace inventory key.
2. Cover the superproject and every initialized registered submodule discovered from Git gitlinks. Reuse proven parent coverage where possible; correctness must not depend on eliminating overlapping handles.
3. Convert filesystem events into canonical workspace-relative path hints or explicit reconciliation requests.
4. Route watcher hints, Phase 2 hints, and full reconciliation through one bounded scheduler and one serialized inventory writer per key.
5. Pass exact file batches to the existing path-scoped collector, preserving every Phase 2 fallback rule.
6. Validate the active collection context, atomically patch the canonical inventory, and publish a versioned delta only when observable inventory state changes.
7. Keep the previous client tree visible while applying deltas or reconciling. Recover transport gaps from a current server snapshot before considering a new filesystem scan.

The watcher must not calculate Git status, baseline state, or submodule ownership itself. Those remain responsibilities of the core collector. Reuse existing path validation, inventory patching, cache-expiry, and snapshot-replacement behavior rather than implementing watcher-specific equivalents.

## Watcher lifecycle

- Start after a session workspace becomes ready; do not create a watcher per browser connection, panel, or expanded workspace view.
- Rebind after checkout/worktree handoff or session replacement. Use a local binding token to reject callbacks and asynchronous results belonging to an old binding, including a restart within the same session generation.
- Add/remove child coverage when registered submodules are initialized, removed, or moved. Refresh registration through the existing core discovery path, not by discovering arbitrary nested repositories.
- Stop all watchers, debounce timers, retry timers, and pending callbacks when a runtime sleeps or is disposed. Cleanup must be idempotent; callbacks already in flight must fail the binding check before committing.
- On wake or lost coverage, re-establish coverage and perform full reconciliation before resuming incremental publication. A failed watcher must degrade to the existing reconciliation behavior, not disable the Files workspace.

### Startup and rebind ordering

1. Resolve and validate the registered roots and capture the active session, inventory key, binding token, and core baseline/topology context.
2. Attach the watchers and begin buffering bounded hints. Establish the backend's documented readiness/coverage boundary before starting the initial full inventory; a backend that cannot establish reliable coverage remains best-effort and must retain bounded reconciliation.
3. Run the initial full inventory through the shared writer. Continue accepting hints while it runs.
4. Publish the snapshot only for the still-active context. Then drain hints received during the scan; if their scope became uncertain or their buffer overflowed, retain the reconciliation requirement and perform a follow-up scan.

Do not scan first and attach watchers afterward: that ordering leaves an avoidable unobserved interval. A filesystem scan is not an atomic filesystem snapshot, so startup buffering supplements, rather than replaces, reconciliation.

## Event handling

Coalesce common editor write patterns such as temporary-file creation followed by rename. Exact file create, modify, and delete hints can use path-scoped collection. For a proven file-to-file rename, enqueue both exact endpoints and let the collector determine their current states; preserve the existing removal and truncation checks.

A raw backend `rename` event is not proof of a matched rename or even of file-only scope. Node documents that this event commonly indicates a name appearing or disappearing, and that a callback may omit the filename.[1] Directory creation/deletion, recursive changes, unmatched or ambiguous renames, unknown file-versus-directory scope, missing filenames, watcher overflow, and Git topology changes must request background reconciliation. Do not pair events using timing guesses or infer scope from filename extensions.

### Bounded batching and backpressure

Suggested initial limits:

| Setting | Initial value / rule |
| --- | --- |
| Exact paths per collection | 100 unique paths |
| Ordinary trailing debounce | 150 ms, within the original 100–250 ms range |
| Maximum pending age | 1,000 ms from the first pending hint |
| Pending-path storage | At most 100 unique paths, separate from an immutable in-flight batch of at most 100 |
| Concurrent inventory updates | One per workspace inventory key, including Phase 2 and full scans |
| Repeated full-scan cooldown | At least 2 seconds after the previous full scan completes; validate against existing reconciliation policy |

The maximum pending age makes a batch runnable even if new events keep resetting the trailing debounce. It does not interrupt an in-flight operation or promise end-to-end completion within one second. Once runnable, a batch must not be postponed by another debounce window when the writer becomes available.

Exceeding a path limit must set `reconcileRequired`; events must never be silently discarded. Collapse excess detail into a bounded dirty marker and a bounded set of reason codes rather than creating an unbounded event queue. Exceeding the debounce age alone flushes an exact batch; it does not require a full scan.

### Shared scheduling and race safety

- Deduplicate normalized paths across watcher and Phase 2 hints while they are pending. Preserve Phase 2's existing freshness expectations: an already-ready agent batch must not be delayed solely to wait for a watcher debounce.
- Move selected paths out of the pending set when collection starts, not when it finishes. A new event for an in-flight path must remain pending for another collection; never erase it at completion.
- Serialize full scans, incremental updates, and versioned invalidation publications through the same writer. Each operation captures its inventory version and active session/binding/core context; reject a result if that context no longer matches at commit. Latch broad invalidations immediately, even while the writer is busy; an exact batch overtaken by a new broad invalidation must yield to reconciliation rather than commit. Baseline or topology invalidation blocks incremental commits until core reconciliation establishes a compatible context.
- Give a required full scan precedence over pending incremental work. Pending pre-scan paths may be covered by that scan, but continue recording new hints after it starts.
- Track a monotonic event sequence and reconciliation-request sequence, or equivalent counters. A successful full scan acknowledges only the work present at its start. Later exact hints remain pending; later broad invalidations keep `reconcileRequired` set. Failure must not acknowledge either kind of work.
- Maintain at most one running operation and one coalesced follow-up reconciliation request. Honor a fixed next-eligible retry/cooldown deadline; incoming events must not postpone it indefinitely. Apply capped backoff to repeated failures rather than running a tight retry loop.

Do not suppress watcher events for a time window after an agent write or assume that a matching path proves the same edit. That could hide an external edit racing with the agent. Pending-set deduplication is safe; blanket time-based suppression is not.

### No-op suppression and client work

After authoritative collection, compare the affected entries and relevant inventory metadata against the canonical inventory. If there are no observable changes, do not advance the inventory version or publish an inventory delta. Compare the complete relevant read-model fields, not only a Git status label or filesystem timestamp. Do not deep-compare the entire inventory for every exact batch.

Observable changes include revision, ordering/count/truncation metadata where applicable, and reconciliation-state transitions. Do not suppress required invalidation messages, and do not suppress existing non-inventory cache invalidation simply because the Files inventory is unchanged.

Apply each delta as one client update. Reuse unchanged entries and directory nodes where the existing client model supports it; preserve expansion and selection rather than rebuilding or clearing the entire tree.

### Noise filtering and Git control signals

Do not add blanket exclusions for names such as `node_modules`, `dist`, or `build`. Reuse an existing core exclusion policy only when it authoritatively proves the affected path cannot contribute to the inventory. Absence from a truncated inventory is not proof, and Git ignore rules do not exclude already tracked files.[2] If safe pruning is not already available, defer it rather than introducing a new ignore engine or running a Git command for each raw event.

Treat `.gitignore`, `.gitmodules`, and changes to any other policy files actually consumed by the collector as potentially wider invalidations, not merely changes to those files. Invalidate the corresponding core caches and request reconciliation. Working-tree control files can still appear in inventory according to the existing collector rules.

Treat relevant Git metadata changes as baseline/topology/policy signals only. Have the core identify the metadata locations and relevant dependencies, such as `HEAD`, the index, relevant refs, and exclusion configuration. Do not trigger a full scan for every object-store or log write. Keep an explicit, reviewed signal classification; unknown potentially relevant metadata changes fall back to reconciliation.

Git worktrees and submodules may use a `.git` file pointing to a separate Git directory.[3] Do not assume metadata lives under `<root>/.git`, or recursively discard the entire superproject metadata tree if it contains relevant registered-submodule metadata. Do not widen the security boundary to watch an external Git directory: retain existing lifecycle/revision invalidation and periodic repair for unwatchable metadata, and record the coverage limitation.

Audit read-only Git commands used by both collectors for self-generated watcher traffic. Where the collector uses background `git status`, validate use of `git --no-optional-locks status` in the shared read-only command path. Git documents that status can otherwise refresh and write the index.[4] This is intended to reduce optional index writes, lock contention, and potential watcher feedback; it must not change mutating Git commands or rely on ignoring events believed to be self-generated. Measure any repeated-stat-work tradeoff.

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

### Server invariants

- Scope snapshots and deltas to the same existing workspace inventory key. Verify the transport already enforces that identity; otherwise add the key to both envelopes before enabling deltas. Session generation alone must not mix different inventories.
- Snapshot responses must include `sessionGeneration`, `version`, and `revision` alongside the existing inventory payload and its completeness/truncation and reconciliation state. Read the payload and version atomically.
- Use one monotonic inventory version sequence for Phase 2 updates, watcher updates, and full replacements. A published delta has `version = baseVersion + 1`. Do not reset versions on a watcher restart; rotate the stream/session identity if continuity cannot be preserved.
- `revision` retains its existing meaning. External filesystem edits can change inventory without changing that revision; clients must use inventory versions rather than Phase 1's unchanged-revision shortcut to decide whether to apply an update.
- Publish a clean-to-`reconcileRequired` transition once through the shared writer, using an empty versioned delta with `reconcileRequired: true` unless a snapshot/replacement already represents that transition. Buffer publication until an initial compatible snapshot exists. A completed repair may satisfy a queued invalidation without an extra message; repeated requests while already dirty do not create additional invalidation versions. Successful reconciliation clears the state through the versioned snapshot/replacement path.
- Bound delta payloads using the existing inventory/transport limits. If an incremental result cannot be safely represented, use snapshot replacement or reconciliation rather than truncating a delta.

### Client application and gap recovery

Clients apply only contiguous deltas for the active inventory key and session generation, with a matching base version. Ignore already-applied versions and callbacks from old subscriptions. Treat malformed or incompatible messages as a reason to resynchronize, not to partially apply data.

A gap retains stale data and requests the latest canonical server snapshot. A transport gap alone does **not** prove the server inventory is stale and must **not** automatically initiate another Git/filesystem scan. Return a valid current snapshot from the canonical cache; join or request full reconciliation only when the server is dirty, expired, or incompatible with the active context.

Coalesce client resynchronization requests. Continue applying contiguous deltas during a snapshot fetch, never replace a newer local version with an older response, and reject responses for an old session/key. Track the highest skipped version observed during the fetch; request another snapshot only if the accepted version still cannot cover it. This avoids requiring an unbounded client delta-replay buffer.

An explicit `reconcileRequired` signal keeps the previous tree visible until a successful compatible replacement is available. A dirty cached snapshot must not be presented as a completed repair. Reuse the existing in-flight reconciliation request where possible; failures retain the tree and use bounded retries.

## Reconciliation

A full background scan remains necessary after:

- watcher overflow, uncertain coverage, backend errors, or path-buffer overflow;
- branch checkout, reset, merge, rebase, or a changed baseline;
- registered-submodule topology or initialization changes;
- directory-wide operations, extraction, generated trees, or ambiguous renames;
- ignore or other collector-policy changes with effects beyond one exact path;
- truncated-inventory deletions where the next cutoff entry is unknown, or any other existing Phase 2 unsafe-patch condition;
- runtime sleep/wake or workspace handoff;
- expiry of the existing authoritative full-inventory freshness bound.

A detected client delta gap or reconnect first requires snapshot resynchronization, not necessarily a new scan. Multiple clients and multiple fallback reasons must converge on the same server-side reconciliation request.

Reconciliation must use stale-while-revalidate: never clear the visible tree before a successful replacement inventory is ready. A same-context scan affected by later hints may be published as provisional/stale, but must retain the pending work and dirty state required by the scheduling rules. Never publish a result from an obsolete baseline, binding, or session.

Preserve periodic repair even when watchers appear healthy. Use the existing reconciliation/cache-expiry mechanism to define a bounded maximum age for a successful full inventory while the runtime is awake and the workspace is in use. If the current mechanism does not provide such a bound, define and validate a configurable interval before rollout; do not add an aggressive per-file polling loop. Incremental successes must not continually reset the full-scan age and thereby prevent repair of silently missed events. An authoritative repair must revalidate the relevant core baseline/topology/policy caches; returning a same-revision cached inventory does not count as a successful full scan.

On reconnect and the existing bounded client refresh cadence, compare against the authoritative server version even if the workspace revision is unchanged. This also repairs a dropped final delta that is not followed by another delta capable of exposing a gap. Reuse those refreshes; do not create an independent timer per view.

Back off and cap watcher restarts. Repeated resource or backend failures should leave the workspace in reconciliation-only mode with diagnostic health state rather than repeatedly reopening watchers. Stop repair/retry activity when the runtime sleeps or is disposed.

## Security

- Canonicalize every watched root and require it to be the registered workspace root or a descendant beneath it, using path-segment-aware containment checks.
- Watch only the superproject and registered Git submodules; never arbitrary nested repositories or external Git metadata directories.
- Reject absolute, traversal, malformed, and overlong event paths. An unusable path triggers a bounded reconciliation request, not an attempt to inspect the rejected target.
- Reuse the existing collector's containment and symlink defenses; watcher normalization is not a security boundary. Do not follow symlinked directories outside the workspace.
- A deleted path cannot necessarily be resolved with `realpath`. Preserve safe exact deletions through the existing core validation rules; do not weaken validation to make missing paths pass.
- Preserve the existing canonical path-identity rules and platform-aware casing. Do not lowercase every path or treat a case-only rename as automatically harmless.
- Treat `.git` internals as topology/policy signals only and never expose them as workspace files.
- Keep diagnostics to bounded counters and reason codes by default; do not include file contents or raw workspace paths in telemetry.

## Cross-platform considerations

Node watcher behavior differs across Windows, macOS, and Linux. Before choosing native `fs.watch` or a dependency, validate recursive support, readiness semantics, rename semantics, missing filenames, atomic replacement, overflow reporting, network filesystems, case-only renames, and resource limits on all supported platforms. Test the product's actual pinned Node versions rather than assuming that the current documentation describes its deployed runtime.[1]

Prefer directory/root coverage over one handle per file; Node documents inode-related caveats for watched files that are deleted and recreated.[1] Verify coverage after root moves/replacements and submodule changes. Where overlapping parent/child coverage cannot be safely eliminated, retain it and deduplicate downstream; resource optimization must not introduce gaps.

Keep the backend behind a small adapter that emits exact path hints, uncertain-scope signals, readiness/coverage state, and errors. Unsupported or unreliable configurations must fall back to the existing reconciliation path. No watcher dependency or blanket polling fallback should be added without this evaluation.

## Required tests

Retain the original scenarios and extend them with deterministic fake-clock/controllable-collector tests before relying on platform integration tests:

- create, modify, delete, clean reversion, and atomic-save rename; proven rename endpoints versus ambiguous raw rename fallback;
- rapid duplicate-event coalescing, including the same pending path arriving from Phase 2 and a watcher;
- continuous editing that never becomes quiet, with the maximum pending age making a batch runnable;
- a second edit to an in-flight path surviving completion of the first batch;
- no-op collection producing no inventory delta/version change, while real read-model and invalidation changes still publish;
- startup buffering and edits during initial/full scans, including overflow and broad invalidation during the scan;
- serialization of Phase 2 patches, watcher patches, and full replacements; failed scans never clearing newer dirty state;
- nested registered-submodule files and overlapping parent/child event delivery;
- submodule initialize/remove/checkout changes, gitfile-based layouts, and unwatchable metadata recovery;
- directory deletion and bulk generation fallback, with bounded memory, coalesced scans, cooldown, and eventual convergence after the burst stops;
- ignore/policy changes affecting files that were not individually touched, and tracked files inside otherwise ignored directories;
- read-only collection not creating an uncontrolled index-event/reconciliation feedback loop;
- symlink and workspace-escape rejection, deleted-path validation, and rejected event payloads;
- watcher overflow, missing filenames, partial coverage, backend/resource errors, bounded restart, and reconciliation-only fallback;
- stale tree retention during failed reconciliation and preservation of unchanged client nodes, selection, and expansion;
- duplicate, out-of-order, missing, malformed, and wrong-session/key delta messages;
- delta gaps recovering from a valid cached snapshot without a new full scan; simultaneous clients sharing a required scan;
- deltas arriving during snapshot fetch, old snapshot responses, and a skipped version observed after a resync request began;
- external edits at an unchanged workspace revision, and a dropped final delta recovered by bounded version refresh;
- silently missed filesystem events repaired by full-inventory expiry even while other paths keep receiving successful deltas;
- Windows path casing/separators, case-only renames, watched-root replacement, and platform-specific atomic saves;
- runtime handoff, sleep, wake, replacement, disposal, and late results/callbacks from a previous binding;
- truncated inventories and every Phase 2 fallback remaining intact, including safe removals and unknown-cutoff deletions;
- feature disablement releasing watcher resources and preserving Phase 1/2 behavior.

After each settled event trace, compare the canonical result with a fresh full collection under the same baseline and truncation policy. Use identical fixtures with watcher support enabled and disabled to detect Phase 2 regressions. Add real-filesystem integration coverage on each supported OS; fake watchers alone cannot validate native event behavior.

## Implementation sequence and rollout

1. **Establish shared update invariants.** Locate the Phase 2 collector, inventory writer, snapshot versioning, expiry rules, and client cache consumers. Add the shared scheduling/commit guards and deterministic tests without enabling watchers. Preserve existing agent-triggered freshness.
2. **Add the coordinator behind a default-off flag.** Implement bounded batching, startup buffering, lifecycle cleanup, reconciliation coalescing, and health/fallback state. Select a backend only after the platform evaluation.
3. **Complete versioned delivery and recovery.** Make snapshots and deltas use the same identity/version rules; add no-op suppression, unchanged-revision handling, cached-snapshot gap recovery, and client-state retention. Keep existing full-refresh compatibility.
4. **Validate representative workloads.** Exercise small and large workspaces, registered submodules, bulk generation, atomic saves, sleep/wake, and the supported OS/filesystem matrix. Compare final correctness and resource use against the existing full-collection path.
5. **Roll out by supported environment.** Start with internal/opt-in workspaces, then expand based on correctness, latency, and resource metrics. A kill switch stops watcher activity and restores reconciliation-only freshness without clearing inventories or disabling Phase 2.

Do not put new Git status logic, heuristic rename pairing, broad ignore pruning, dynamic debounce algorithms, or a persistent replay log on the initial delivery path. Measure first; add those only as separately reviewed work if evidence justifies them.

## Acceptance criteria and observability

These are validation criteria, not claims of achieved speedups:

- A supported isolated exact-file edit in a healthy, compatible inventory uses path-scoped collection and no event-triggered full scan, except for the documented existing safety fallbacks.
- One hundred duplicate hints for one path delivered before collection starts produce one collection. Mixed Phase 2/watcher hints already pending for that path are included; later hints are retained rather than incorrectly suppressed.
- A no-op batch produces zero inventory delta publications and zero version increments. A changed batch publishes at most one inventory delta unless the snapshot/fallback path is required.
- Continuous exact-file activity makes pending work runnable within the configured maximum age. Record writer wait and collector time separately from debounce time.
- A finite burst of broad invalidations is coalesced rather than producing one full scan per event. After the final relevant event, at most one follow-up scan is needed beyond an already-running scan, assuming no failures or further invalidations.
- Pending path memory and active update concurrency stay within their configured bounds. All lifecycle resources are released after disposal, sleep, or feature disablement.
- After settling and successful repair, incremental and full-collection results agree, including truncation metadata and submodule ownership. No old-context result commits and no refresh failure blanks the visible tree.

Collect bounded metrics for raw hints, unique paths, coalescing ratio, no-op batches, queue wait, collection duration, observed-event-to-client-apply latency, delta bytes, full-scan counts/duration by reason, snapshot-only resyncs, last successful full-scan age, watcher handle count, restarts, and fallback mode. Measure scan cost and watcher overhead on representative repositories before choosing release thresholds; the supplied plan contains no benchmark baseline from which to claim a percentage improvement.

## Rationale for the changes

| Change | Expected impact | Risk containment |
| --- | --- | --- |
| Shared Phase 2/watcher scheduling and no-op suppression | Avoid redundant pending-path collection, duplicate notifications, and unchanged tree updates | Keep the authoritative collector and do not suppress later concurrent edits |
| Maximum batch age and bounded trailing work | Prevent debounce starvation and unbounded memory under sustained activity | Fixed, configurable limits with the existing full-scan fallback |
| Buffered startup, shared writer, and context/sequence checks | Avoid missed startup work, stale commits, and clearing invalidations that arrived during a scan | Small coordinator state; existing baseline/topology semantics stay in core |
| Cached-snapshot recovery for client gaps | Avoid a filesystem/Git scan when only delivery to a client was incomplete | Escalate whenever server validity is uncertain; retain stale data while repairing |
| Focused control signals and read-only Git audit | Reduce unnecessary scans and possible collector-generated watcher feedback | Preserve policy/topology invalidation and validate command behavior before rollout |
| Periodic repair, resource fallback, and gated rollout | Recover silent misses and allow safe operational rollback | Reuse existing refresh policy; no aggressive polling or new mandatory dependency |

## External validation references

These references support the platform/Git caveats introduced in this revision. They do not establish Pylon's current implementation or any measured performance result.

[1]: https://nodejs.org/api/fs.html#fswatchfilename-options-listener "Node.js: fs.watch, including caveats, inodes, and filename behavior"
[2]: https://git-scm.com/docs/gitignore "Git: gitignore semantics and tracked files"
[3]: https://git-scm.com/docs/gitrepository-layout "Git: repository layout, gitfiles, and shared metadata"
[4]: https://git-scm.com/docs/git-status#_background_refresh "Git: background status refresh and optional index locking"
