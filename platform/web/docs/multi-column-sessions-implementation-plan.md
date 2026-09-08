# Nested multi-column session workspaces implementation plan

Status: proposed

## Goal

Allow one Pylon Web browser tab to display multiple sessions side by side, while each displayed session can contain multiple independently sized workspace panes.

The layout has two explicit levels:

```text
Session group A
├─ Workspace pane: Chat
├─ Workspace pane: Files
└─ Workspace pane: Database

Session group B
├─ Workspace pane: Chat
└─ Workspace pane: Browser
```

A **session group** owns one session target and visually groups all panes using that session. A **workspace pane** is one horizontal column within the group and displays one of the existing session surfaces:

- Chat
- Files
- Database
- Browser

Global Sessions, Usage, and Archive remain application-level views. They are not workspace panes.

## Core model

```ts
type SurfaceId = "chat" | "files" | "database" | "browser";

interface WorkspacePane {
  paneId: string;
  surface: SurfaceId;
  width: number;
  reference?: string;
}

interface SessionGroup {
  groupId: string;
  sessionId: string;
  panes: [WorkspacePane, ...WorkspacePane[]];
}

interface SessionWorkspaceLayout {
  groups: SessionGroup[];
  focusedPaneId?: string;
}
```

The nested representation is intentional rather than a presentation-only grouping over a flat list. It makes session ownership, hydration, lifecycle, and same-session pane contiguity explicit while keeping the pane design replaceable later.

### Invariants

1. One browser layout contains at most one group for a session.
2. A group always contains at least one pane.
3. Panes in one group remain contiguous under a shared session header.
4. Hydration, incarnation, recovery, transcript, runtime queue, and canonical pending-message state are session scoped and processed once per group.
5. Surface, width, local navigation, scroll, selection, request sequence, and pane-owned resource claims are keyed by stable `paneId`.
6. Hydration limits count distinct session groups, not panes.
7. Closing the final pane removes the group from the layout but does not archive, delete, abort, or otherwise terminate the session.
8. Opening a session already present focuses its group; opening a surface already present focuses that pane.
9. The first release allows each surface at most once per session group. This avoids duplicate Chat composers, Browser ownership, and Database transaction ambiguity while leaving duplicate panes as a future extension.
10. Moving a pane is initially limited to its current group. Moving it to another group would change its session target and must be a separate explicit feature with state reset and ownership validation.

## Product decisions

1. Use ordered session groups containing ordered workspace panes. Do not use a recursive split tree.
2. Render a shared session header across every pane in a group. Session status, target, lifecycle, and group movement belong there.
3. Render surface identity, pane movement, resize, close, and pane resource status in each pane.
4. The total pane count is user-defined and overflows horizontally. Panes retain a usable minimum width rather than shrinking to fit.
5. Add session creates a new outer group with a default Chat pane.
6. Add workspace adds an unused Chat, Files, Database, or Browser pane to the focused session group.
7. A pane may switch to another unused surface in its group. Switching never alters a sibling pane.
8. Keep lightweight group and pane shells mounted so order, focus, surface, drafts, and scroll survive horizontal navigation.
9. Hydrate expensive runtime state only for a bounded set of distinct sessions. Separately bound pane resources such as Database results and Browser mirrors.
10. Use one authenticated multiplexed SSE connection per browser tab, not one connection per group or pane.
11. Address every runtime and surface operation with an explicit session and authoritative incarnation. Include `paneId` where presentation, cancellation, confirmation, or resource ownership matters.
12. Preserve selected-session APIs as compatibility adapters until the targeted path has behavioral parity. Never silently route a nested pane through whichever session is globally selected.
13. Initial delivery may enable Chat before Files, Database, and Browser. Unsupported panes remain visible as unavailable rather than falling back to another target.
14. Existing sleeping, pinning, worktree isolation, confirmation, CSRF, tab registration, project validation, and resource ownership rules remain authoritative.
15. Use native horizontal scrolling, CSS layout, pointer events, keyboard controls, and bounded persistence. Revisit a generalized docking system only if later requirements include interleaved groups, vertical splits, or arbitrary docking.

## Non-goals

- Sessions, Usage, or Archive as child workspace panes.
- Project-only or all-projects catalog columns.
- Multiple groups for the same session in one layout.
- Duplicate same-surface panes within one session group in the first release.
- Dragging a pane directly into another session group.
- Vertical splits, nested split ratios, floating windows, or arbitrary docking.
- An unbounded number of awake session runtimes, Database queries, or Browser mirrors.
- Cross-device or multi-user collaboration.
- Changing worktree, checkout ownership, apply, handoff, or Timeline safety rules.
- Persisting runtime state or sensitive surface content in the layout record.

## Existing foundation

### Already available

- `RuntimeCoordinator` owns multiple runtime slots and can keep non-selected sessions awake.
- Active, pinned, running, and queued sessions already participate in sleeping rules.
- Runtime/event envelopes contain session identity and generation fields.
- Browser requests use an HttpOnly browser-session cookie, CSRF token, registered tab ID, and same-origin transport.
- The client has per-session caches for some history, files, drafts, and retained terminal state.
- `SurfaceId` already defines Chat, Files, Database, and Browser.
- Navigation explicitly distinguishes global workspace views from session surfaces.
- Desktop CSS already uses grids, pointer/keyboard resizing, persisted dimensions, responsive overlays, and narrow-screen drawers.

### Blocking assumptions to remove

- `RuntimeCoordinator.selectedId` and a global generation determine the target for ordinary commands and snapshots.
- Selecting a session emits `session.replaced`, resets the shared journal, and reboots the singleton client projection.
- `ServerTransport` maintains one selected runtime, dialog owner, and last-command owner.
- Most runtime commands do not carry an explicit target session.
- `RuntimeEventStore` owns one snapshot, generation, event source, and recovery state.
- `App` owns singular surface, reference, Browser, pending-session, toast, and selection state.
- Files uses a separate shell from Chat, Database, and Browser.
- Database and Browser routes resolve the selected runtime in important paths.
- Surface state cannot currently distinguish two sibling panes using one session.

CSS grouping alone cannot fix these ownership assumptions.

## Target architecture

```text
Browser tab
├─ BrowserSession cookie + CSRF + tabId
├─ global chrome
│  ├─ Sessions
│  ├─ Usage
│  └─ Archive
├─ NestedSessionWorkspace
│  ├─ ordered SessionGroupController[]
│  │  ├─ group A / session A
│  │  │  ├─ pane A1 / Chat
│  │  │  ├─ pane A2 / Files
│  │  │  └─ pane A3 / Database
│  │  └─ group B / session B
│  │     ├─ pane B1 / Chat
│  │     └─ pane B2 / Browser
│  ├─ focusedPaneId
│  └─ horizontal viewport
├─ WorkspaceCatalogStore
│  └─ projects and session summaries for global navigation
├─ HydrationCoordinator
│  └─ bounded distinct session target set
└─ MultiplexedRuntimeTransport
   ├─ one EventSource and replay cursor
   ├─ global event router
   └─ session event router

SessionStore A / incarnation A
├─ canonical runtime snapshot
├─ transcript, queue, pending messages, pending UI
└─ pane controllers A1, A2, A3

SessionStore B / incarnation B
└─ pane controllers B1, B2
```

The server and transport know session targets and resource owners; they do not need to reproduce the visual tree. `groupId` and `paneId` are client layout identities scoped beneath the authenticated tab and are not authorization capabilities.

## State ownership

| State | Owner |
| --- | --- |
| Cookie, CSRF, tab ID, EventSource, stream cursor, protocol recovery | `MultiplexedRuntimeTransport` |
| Projects, Sessions/Usage/Archive data, summaries, global settings | `WorkspaceCatalogStore` |
| Active distinct session set and hydration/eviction decisions | Hydration coordinator |
| Session ID, incarnation, runtime snapshot, transcript, queue, pending messages/UI, recovery | `SessionStore` keyed by session |
| Group ID, session assignment, pane order, session header state | `SessionGroupController` |
| Pane ID, surface, width, reference, scroll, selection, request sequence | `WorkspacePaneController` |
| Chat draft | Existing durable session-scoped draft store; only one Chat pane per group initially |
| Files selection/content view | Pane-local, backed by session/worktree data |
| Database editor/results/confirmation presentation | Pane-local; transaction and policy remain authoritative server/session state |
| Browser mirror/view/control presentation | Pane-local; lease remains authoritative server/session state |
| Focused pane and ordered groups | Versioned bounded layout storage |

Session events reduce once into the matching `SessionStore`. Sibling panes derive their views from that store rather than receiving duplicated event streams. Pane-local async requests use `(sessionId, incarnation, paneId, requestId)` guards so a late response cannot update a closed, switched, or recreated pane.

## Group, pane, and runtime states

| State | Applies to | Meaning |
| --- | --- | --- |
| Mounted | Group and pane | Lightweight layout identity and safe local presentation state exist. |
| Visible | Pane | Some part of the pane intersects the horizontal viewport. |
| Focused | Pane | Pane owns current layout keyboard actions. |
| Hydrated | Group/session | Current session snapshot exists and targeted events are subscribed. |
| Busy-pinned | Group/session | Running work, queue, pending UI, or owned resource prevents safe eviction. |
| Dormant | Group/session | Pane shells remain, but the expensive session projection is not retained. |
| Activation-waiting | Group/session | Hydration was requested but all eligible slots are busy-pinned. |
| Resource-owned | Pane | A Database confirmation, Browser mirror/control, or similar claim belongs to this pane. |

Hydration priority counts groups:

1. busy-pinned session groups;
2. the group containing the focused pane;
3. groups with visible panes;
4. recently used groups within the active target limit.

When capacity is reached:

- evict only an idle session whose panes are non-visible and non-focused and whose resources permit eviction;
- never abort a command, discard a dialog, cancel a Database confirmation, or release Browser control merely to hydrate another group;
- show activation waiting when no safe session can be evicted;
- keep every pane shell and its safe local state mounted;
- obtain a fresh snapshot/incarnation before re-enabling any sibling pane after wake.

A group with three panes consumes one session hydration slot. It may still consume separate bounded surface resources.

## Identity, routing, and ownership

Use distinct identities:

- `sessionId`: durable session identity.
- `incarnation`: authoritative token for one live runtime slot.
- `groupId`: stable page/layout identity for the one group presenting a session.
- `paneId`: stable identity for one child workspace pane.
- `streamSequence`: global multiplexed SSE replay position.
- `commandId` / `requestId`: operation idempotency and reconciliation identities.

| Operation | Required target |
| --- | --- |
| Global Sessions/Usage/Archive read | Authenticated browser workspace/tab; no runtime generation |
| Prompt, queue, steer, abort, model or history action | Session + incarnation; pane for ownership/presentation |
| Session lifecycle action | Explicit session ID and lifecycle preconditions |
| Files read/apply/handoff | Session + incarnation where live state is involved; pane request identity |
| Database query/mutation/confirmation | Session + incarnation + tab + pane/resource owner |
| Browser command/mirror/control | Session + incarnation + tab + pane/resource owner |
| Interactive UI answer/keep-alive | Session + incarnation + request + tab + pane owner |

The server derives browser-session and tab identity from authenticated transport state. It validates all supplied IDs and never treats `groupId` or `paneId` as authority.

## Coordinator and multiplexed protocol

Add targeted coordinator operations alongside legacy selected-session methods:

```ts
snapshotSession(sessionId: string, expectedIncarnation?: string): Promise<RuntimeSnapshot>
executeSessionCommand(target: SessionTarget, command: SessionRuntimeCommand): Promise<CommandResult>
activateSessionTarget(sessionId: string): Promise<SessionTarget>
```

Required behavior:

- resolve only the requested slot;
- wake/create only through explicit validated operations;
- return authoritative incarnation with snapshots/results;
- reject missing, sleeping, archived, deleted, or replaced targets with stable errors;
- emit non-selected runtime events with source identity;
- execute multiple requests for sibling panes against one shared session slot without duplicating the slot;
- preserve session-level serialization/concurrency rules where required;
- never change global visual selection merely because a targeted command executes;
- enforce active-session limits without disposing busy-pinned targets.

Prefer additive `/api/v2` routes while v1 remains compatible:

```text
POST /api/v2/bootstrap
POST /api/v2/subscriptions
GET  /api/v2/events
POST /api/v2/commands
```

Bootstrap returns global catalog/layout prerequisites. Hydration requests contain a bounded set of distinct session IDs, regardless of pane count. The one SSE stream uses a global sequence; each event is global or session-addressed with session ID, incarnation, event type, and payload version.

Subscription updates establish an authoritative cursor boundary, hydrate newly accepted sessions, advance the cursor for every event, and recover expired cursors without discarding unaffected groups or pane shells.

## Surface behavior inside a group

### Chat

- Transcript, runtime queue, canonical pending messages, steer/abort, and runtime errors are session scoped.
- Composer focus, transcript scroll, references, and transient presentation are pane scoped.
- One Chat pane per group avoids simultaneous composer/draft ambiguity in the first release.
- Sending from Chat never changes sibling Files, Database, or Browser state.

### Files

- Adapt the existing Files shell into a child pane.
- Key selection, loaded file, diff scroll, and cancellation by pane while sourcing data from the group's explicit session/worktree.
- Preserve handoff, apply, policy, and worktree isolation.
- Late file responses cannot populate a switched or closed pane.

### Database

- Resolve context from the group's explicit session.
- Keep connection selection, editor text, results, paging, and confirmation presentation pane-local.
- Preserve query/result limits, secret handling, read-only state, transaction, and confirmation policy.
- One Database pane per group initially avoids multiple panes racing one session transaction/confirmation.

### Browser

- Include session, incarnation, tab, and pane ownership in commands and mirror requests.
- Keep the control lease authoritative per target Helios runtime while recording the claiming pane.
- Prevent sibling close/switch from aborting another pane's resource.
- Define off-screen mirror/control retention and explicit release.
- One Browser pane per group initially avoids two sibling panes competing for one control lease.

Until a surface's routes are explicitly targeted, the corresponding Add workspace option is disabled in multi-column mode with an explanation.

## Layout and interactions

The visual hierarchy uses one outer horizontal strip of session groups. Each group has a shared header and an inner horizontal pane strip:

```css
.session-group {
  display: grid;
  grid-template-rows: var(--group-header-height) minmax(0, 1fr);
  width: max-content;
}

.session-pane-strip {
  display: flex;
  min-width: 0;
}

.workspace-pane {
  flex: 0 0 var(--pane-width);
  min-width: var(--pane-min-width);
  max-width: var(--pane-max-width);
}
```

This is a two-level ownership/layout model, not a general recursive docking engine.

### Group interactions

- Add session inserts a new group after the focused group with one Chat pane.
- Opening an already displayed session focuses its group instead of duplicating it.
- Move session left/right moves the whole group and preserves child order/ownership.
- Retarget session is optional for the first release; if enabled, it requires idle/resource-safe state and resets every pane's session-bound state.
- Removing a group closes its panes from the layout only; it does not terminate the session.

### Pane interactions

- Add workspace inserts an unused surface after the focused pane in that group.
- Surface switching offers only surfaces not already used by a sibling pane, plus the current surface.
- Move pane left/right stays within the group.
- Resize changes only that pane's width.
- Close pane releases or safely resolves only that pane's requests/resources. Closing the final pane removes the group.
- Focus, previous/next, and the picker identify both session and surface.
- Horizontal scrolling uses native wheel/trackpad/touch behavior.
- Group/session and pane/surface actions have distinct accessible names and announcements.

At narrow widths, each pane defaults to approximately one viewport width. The group header remains associated with the currently visible pane. Previous/next and a hierarchical picker become primary navigation; nested horizontal scrollers are avoided by letting the outer viewport own horizontal scrolling while groups remain contiguous segments.

## Lifecycle edge cases

### Closing or switching a pane

- Cancel only cancellable pane-local requests.
- Reject later responses using pane/request identity.
- An answerable confirmation or active exclusive resource blocks close, transfers through an explicit action, or follows existing safe-release behavior; never silently discard it.
- Switching surface clears incompatible transient presentation and preserves only intentionally durable state.

### Closing the final pane

- Remove the group layout shell.
- Release its client subscription if no other reason keeps the session active.
- Do not abort running work, archive/delete the session, or destroy a pinned runtime.
- Continue bounded global status notifications so completion remains discoverable.

### Incarnation replacement

- Rehydrate the group once.
- Invalidate incarnation-bound requests/caches in every sibling pane.
- Preserve safe layout state such as pane order, surface, width, and non-sensitive local navigation.
- Re-enable panes only against the fresh incarnation.

### Session archive/delete/unavailability

- Disable all panes in the affected group and show one coherent group-level unavailable state.
- Resolve owned resources according to existing lifecycle policy.
- Remove or retarget only after explicit user action where required.
- Leave unrelated groups fully interactive.

## Persistence and migration

Persist bounded layout metadata only:

```ts
interface PersistedSessionWorkspaceLayout {
  version: number;
  focusedPaneId?: string;
  groups: Array<{
    groupId: string;
    sessionId: string;
    panes: Array<{ paneId: string; surface: SurfaceId; width: number; reference?: string }>;
  }>;
}
```

Validate maximum bytes, group count, total pane count, panes per group, unique bounded IDs, unique session groups, at least one pane per group, unique surfaces per group, valid widths/surfaces/references, and authoritative session existence.

Do not persist runtime snapshots, catalog responses, hydration/incarnation state, pending commands, approvals, ownership, transactions, Database results, Browser images/leases, credentials, attachments, or full histories. Composer text remains in the existing session-scoped draft store.

Migration:

1. validate size and version before constructing controllers;
2. convert current scalar selected-session/surface state into one group with one pane;
3. if a preview flat-column record ever exists, group equal session IDs by first appearance and preserve each pane's relative order;
4. remove duplicate surfaces deterministically and preserve the first valid pane;
5. reconcile session IDs against the catalog;
6. fall back to one valid session with Chat when no group remains;
7. mount all valid shells but hydrate only the bounded initial distinct-session set;
8. restore focus by pane ID and scroll it into view;
9. ignore corrupt or future-version records without blocking Pylon.

## Security and bounds

- Retain same-origin, allowed-host, HttpOnly cookie, CSRF, registered-tab, request-size, and no-store controls.
- Treat session/group/pane IDs, incarnations, order, widths, surfaces, cursors, and request IDs as untrusted.
- Verify session access and incarnation at dispatch and asynchronous completion.
- Never select or wake an unknown session implicitly.
- Bound groups, panes, panes per group, histories, files, Database rows, Browser images, hydration batches, journal replay, and concurrent resources.
- Scope pending UI/resource ownership by `(sessionId, incarnation, requestId, tabId, paneId)`.
- Prevent sibling panes from answering, cancelling, keeping alive, or stealing another pane's request.
- Preserve transaction, confirmation, policy, worktree, and Helios exclusivity checks at authoritative boundaries.
- Keep sensitive content out of global catalog and persisted layout state.

## Implementation sequence

### Phase 0 — contracts, invariants, and compatibility

- Classify every command and surface request as global, session-level, or pane-owned.
- Define session target/incarnation, group/pane identities, event envelopes, layout schema, and measured limits.
- Define one-group-per-session, nonempty-group, contiguity, and one-surface-per-group invariants.
- Capture current single-session surfaces, selection, SSE replay, ownership, sleeping, and security behavior.

Exit: routing and ownership are explicit; current v1 behavior remains unchanged; capacity cannot silently abort work.

### Phase 1 — targeted coordinator and driver

- Add slot incarnations and targeted snapshot/command/resource lookup.
- Forward non-selected events with source identity.
- Scope pending runtime work to session and presentation/resource claims to pane where needed.
- Enforce active-session limits without disposing busy targets.

Exit: at least three sessions run concurrently; several requests from sibling panes resolve against one slot; stale incarnation affects only its session.

### Phase 2 — multiplexed HTTP/SSE

- Add bounded bootstrap/hydration and distinct-session subscriptions.
- Add session-addressed dispatch and one v2 SSE journal.
- Scope UI/resource ownership by session/incarnation/tab/pane.
- Implement replay, reset recovery, cancellation, and stale completion rejection.
- Keep v1 operational through compatibility adapters.

Exit: pane count does not duplicate session subscriptions; cross-session, cross-pane, stale, malformed, oversized, unknown-tab, CSRF, and replay-gap attempts fail safely.

### Phase 3 — scoped client stores

- Introduce one multiplexed transport manager.
- Split singleton runtime state into `SessionStore`, `SessionGroupController`, and `WorkspacePaneController`.
- Keep Sessions/Usage/Archive in global catalog state.
- Add group-based hydration and safe eviction.
- Adapt current single-session flow through one group/one pane first.

Exit: existing behavior passes through new boundaries; sibling panes share one session reduction; no additional `EventSource` opens.

### Phase 4 — nested Chat/layout MVP

- Add ordered groups, child panes, shared headers, stable IDs, and bounded persistence.
- Implement add/remove/move group and add/remove/move/resize/focus pane behavior.
- Add previous/next and hierarchical picker navigation.
- Enable one Chat pane per group with independent focus/scroll and session-scoped transcript/queue/draft.
- Add dormant and activation-waiting group states.
- Show Files, Database, and Browser as unavailable until targeted.

Exit: multiple session groups operate concurrently; nested order and focus restore; last-pane removal is safe; unrelated groups remain mounted.

### Phase 5 — Files and Database panes

- Adapt Files into the pane body and target all requests explicitly.
- Parameterize Database connection/query/mutation/confirmation by session and pane owner.
- Separate pane caches, selections, requests, cancellation, and stale guards.
- Preserve worktree, handoff, apply, transaction, policy, and confirmation safety.

Exit: one session can show Chat, Files, and Database simultaneously; sibling completion updates only the intended pane presentation.

### Phase 6 — Browser pane

- Implement targeted Helios commands, mirror streams, and control leases.
- Enforce separate resource limits and activation waiting.
- Define off-screen behavior and explicit release.
- Add pane-specific cleanup and reconnect.

Exit: Browser pane ownership cannot be stolen or aborted by a sibling or another session.

### Phase 7 — hardening

- Measure event rate, journal size, DOM/memory cost, group/pane counts, hydration churn, surface payloads, and horizontal interaction.
- Exercise sleep, pin, pane close, final-pane close, session archive/delete, restart, refresh, offline/reconnect, and protocol mismatch.
- Complete accessibility, zoom, RTL, touch/trackpad, reduced-motion, and responsive checks.
- Decide separately whether evidence justifies v1 retirement, duplicate same-surface panes, pane transfer between groups, or virtualization.

## Behavioral verification

Tests protect observable behavior and failures, not labels, icons, registration, schema text, or CSS formatting.

### Nested ownership

- Two panes in one group use one session store, incarnation, runtime slot, and subscription.
- Files and Database sibling panes retain independent selection, requests, scroll, and errors.
- At least three groups concurrently prompt, queue, steer, abort, and answer dialogs without cross-routing.
- Session events reduce once and become visible to every relevant sibling pane.
- Pane events and late responses affect only the addressed live pane.

### Layout transitions

- Add session inserts one new group with Chat after the focused group.
- Add workspace inserts an unused surface after the focused pane.
- Re-adding a displayed session or surface focuses the existing target.
- Moving a group preserves all child order and ownership.
- Moving a pane never leaves its group.
- Closing a pane preserves siblings; closing the last pane removes only the layout group.
- Resizing changes only the target pane.
- Horizontal updates do not reset unrelated scroll or focus.

### Hydration and lifecycle

- Hydration limits count groups/distinct sessions rather than panes.
- Busy session work or owned pane resources prevent unsafe eviction.
- Activation waiting appears rather than aborting work when all eligible sessions are pinned.
- Incarnation replacement invalidates all stale sibling requests and rehydrates once.
- Archive/delete/unavailable state updates every pane in the target group and no unrelated group.

### Surfaces and resources

- Chat transcript/queue is session scoped while pane presentation remains local.
- Files selection/content/apply state cannot cross pane or session boundaries.
- Database editor/results/transaction confirmation cannot cross pane or session boundaries.
- Browser mirror/control/cleanup cannot cross pane or session boundaries.
- Disabled panes never execute through the legacy selected session.

### Persistence and accessibility

- Valid nested layouts restore group order, pane order, widths, surfaces, references, and focused pane.
- Corrupt, oversized, empty-group, duplicate-session, duplicate-surface, over-limit, stale, and future-version records fall back safely.
- Reload never restores stale approvals, ownership, transactions, handles, hydration claims, or incarnations.
- Shared headers expose accessible group/session names.
- Pane controls and announcements identify both session and surface.
- Keyboard/pointer resize and movement respect group boundaries.
- Previous/next and picker reach every off-screen pane at narrow widths.

Expected implementation gate:

```sh
npm run verify --workspace @pylon/web
```

Use the repository root changed-scope verification as the final integration gate.

## Proposed file impact

```text
platform/web/src/shared/protocol/
├─ commands.ts                 # global/session command envelopes and pane ownership
├─ envelope.ts                 # v2 global/session events and stream sequence
├─ snapshots.ts                # subscriptions and incarnation fields
├─ ui.ts                       # pane-scoped interactive ownership
└─ helios.ts                   # targeted Browser ownership

platform/web/src/server/pi/
├─ pi-driver.ts                # targeted driver contract
├─ runtime-coordinator.ts      # incarnations, limits, targeted dispatch
└─ session-runtime.ts          # authoritative session state

platform/web/src/server/http/
├─ router.ts                   # v2 bootstrap, subscriptions, commands, journal
├─ security.ts                 # browser/tab/CSRF validation
└─ terminal.ts                 # targeted resource resolution where applicable

platform/web/src/client/runtime/
├─ api-client.ts               # v2 transport and targeted resource URLs
├─ event-store.ts              # split singleton responsibilities
├─ multiplexed-transport.ts    # one connection and event router
├─ hydration-coordinator.ts    # group-based active session policy
└─ session-store.ts            # one state unit per distinct session

platform/web/src/client/
├─ App.tsx                     # global chrome and nested workspace composition
├─ session-group.tsx           # shared session header and pane strip
├─ workspace-pane.tsx          # one Chat/Files/Database/Browser pane
├─ use-workspace-layout.ts     # nested ordering, invariants, persistence
├─ column-navigation.tsx       # group/pane add, close, move, focus
├─ conversation-panel.tsx      # explicit session/pane controller
├─ file-workspace.tsx          # child pane adaptation
├─ database-panel.tsx          # targeted query/confirmation state
├─ browser-panel.tsx           # targeted mirror/control lifecycle
├─ navigation.ts               # surface availability
└─ styles.css                  # group headers, panes, separators, responsive layout

platform/web/test/
├─ runtime-coordinator.test.ts
├─ runtime-event-store.test.ts
├─ server-transport.test.ts
├─ generation-gate.test.ts
├─ terminal-transport.test.ts
└─ navigation.test.ts
```

Extract files only when a phase gives them independent behavior; do not create the whole proposed tree up front.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Same-session panes duplicate runtimes or event reduction | One `SessionStore` and subscription per distinct session group. |
| Pane response updates a sibling | Guard with session, incarnation, pane, and request identity. |
| Shared session state is accidentally pane-local | Document state ownership and reduce runtime events only in `SessionStore`. |
| Pane state is accidentally shared | Keep surface selection, width, scroll, selection, and request sequence in pane controller. |
| Closing a pane kills session work | Separate layout removal from runtime lifecycle; preserve busy/pinned sessions. |
| Database or Browser ownership collides between siblings | One such surface per group initially plus authoritative pane owner checks. |
| Moving a pane changes its session implicitly | Restrict movement to its current group in the first release. |
| Nested model becomes a docking framework | Keep exactly two ordered levels and no arbitrary splits. |
| Horizontal hierarchy is hard to read | Shared spanning header, group boundary styling, and hierarchical navigation labels. |
| Narrow layout introduces nested scroll traps | One outer horizontal scroller; groups are contiguous segments, not inner scroll containers. |
| User-defined panes exhaust resources | Separate bounded shell, distinct-session hydration, and surface-resource limits. |
| Migration loses same-session pane order | Group by first session appearance and preserve relative pane order deterministically. |
| Browser routes use selected-session fallback | Keep pane unavailable until all routes accept explicit target and owner. |

## Open decisions before implementation

1. Exact incarnation representation.
2. Measured maximum groups, total panes, panes per group, active sessions, Database resources, and Browser mirrors/control leases.
3. Whether pane surface switching swaps with an existing sibling or simply disables already-used surfaces; disabling is the initial recommendation.
4. Whether group retargeting ships initially or groups are created/removed only.
5. Whether closing a pane with an owned confirmation/resource blocks, prompts, or offers explicit transfer.
6. Whether off-screen Browser panes retain mirrors or control leases.
7. Whether layout persistence is browser-global or project-scoped when groups span projects.
8. Which Inspector references are pane-local and which are shared session projections.
9. Whether completion announcements are global, group-level, or deduplicated by session.
10. Whether later demand justifies duplicate same-surface panes, cross-group pane transfer, or distant-pane virtualization.

## Completion criteria

- [ ] The layout is an ordered list of session groups, each with one or more workspace panes.
- [ ] One session group can visibly contain Files and Database panes at the same time.
- [ ] Every pane targets Chat, Files, Database, or Browser; Sessions, Usage, and Archive remain global.
- [ ] Same-session panes share one runtime/incarnation/subscription but retain pane-local presentation state.
- [ ] Hydration limits count distinct sessions, with separate bounds for pane resources.
- [ ] Add/move/remove session group and add/move/resize/switch/remove pane interactions preserve hierarchy and ownership.
- [ ] Closing the final pane removes the group without implicitly terminating its session.
- [ ] Commands, events, pending UI, cancellation, confirmations, and resources route by session/incarnation and pane owner where required.
- [ ] Simultaneous work across sibling panes and multiple groups cannot cross boundaries.
- [ ] One group may sleep, wake, fail, archive, delete, move, or dehydrate without resetting another group.
- [ ] One authenticated multiplexed SSE connection serves global events and bounded distinct session targets.
- [ ] Every surface either targets its group session explicitly or is unavailable with no selected-session fallback.
- [ ] Nested persistence is bounded, versioned, validated, and contains no runtime or sensitive state.
- [ ] Desktop and narrow navigation identify both session group and pane surface accessibly.
- [ ] Behavioral tests cover sibling Files/Database panes, at least three concurrent sessions, and layouts above the hydration limit.
- [ ] Existing single-session behavior remains representable as one group with one pane throughout migration.
