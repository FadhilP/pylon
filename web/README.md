# Pylon Web

Local React client and single-process Node host for Pylon.

```sh
npm install
npm run dev --workspace @pylon/web
```

`dev` starts the Pi runtime, same-origin API, SSE stream, and Vite middleware on `127.0.0.1:3141`. Set `PYLON_CWD` or `PYLON_PORT` when needed.

Production:

```sh
npm run build --workspace @pylon/web
npm run start --workspace @pylon/web
```

Checks:

```sh
npm run typecheck --workspace @pylon/web
npm test --workspace @pylon/web
npm run build --workspace @pylon/web
```

## Runtime status

Phases 0 through 4 are implemented:

- direct Pi SDK `AgentSessionRuntime` lifecycle and generation-safe extension rebinding
- root `pi.extensions` discovery and RPC-compatible fail-closed extension UI
- single-process loopback host with bootstrap, command, UI-response, health, and SSE endpoints
- Host/Origin and Fetch Metadata checks, HttpOnly session cookie, CSRF, CSP, and request limits
- bounded event replay, command idempotency, stale-generation rejection, and reconnect handling
- owner-bound select, confirm, input, and editor dialogs with strict expiry, reconnect grace, owner-loss cancellation, and explicit cross-tab transfer
- keyboard-accessible dialogs with initial focus, focus trapping/restoration, Escape cancellation, labelled modal semantics, live expiry/error announcements, and reduced-motion support
- bounded notify, status, widget, title, and editor-text projections retained across bootstrap/replay
- fail-closed concurrent dialogs and neutral contracts for unsupported TUI-only extension methods
- live message, tool, queue, retry, compaction, model, token, context, and cost state
- bounded Verify, Heartbeat, Guard, tool-policy, and package-health projections
- package-owned Continuity and Timeline snapshots with revision-safe invalidation
- live operational panels with empty and version-incompatible unavailable states; no production fixtures
- loading, disconnected, empty, error, prompt, follow-up, and abort UI states
- bounded session listing with opaque IDs plus new, resume, switch, and fork replacement flows
- full re-bootstrap after every replacement, including cross-workspace cwd changes
- Timeline restore, fork, and clear routed through package-owned commands and remote confirmation
- generation-safe extension-initiated replacement with pending dialog and operational-state teardown

Package mutations continue through Pi prompts and package-owned commands; the host does not execute extension tools directly.

Key executable coverage:

- `test/direct-sdk.integration.test.ts`: SDK binding, dialogs, direct and extension-initiated replacement, stale generations, and shutdown
- `test/server-transport.test.ts`: security, readiness, size limits, idempotency, replacement, session listing, Timeline dispatch, stale commands, duplicate/foreign responses, cross-tab transfer, reconnect, and owner-loss cancellation
- `test/remote-ui.test.ts`: dialog correlation/expiry, fail-closed concurrency, fire-and-forget bounds, and exact unsupported-method neutral values
- `test/projection.test.ts`: bounded extension UI and operational read models and mutation events
- `test/operational-projections.test.ts`: package-version isolation, output bounds, revisions, and policy removal
- `packages/pi-guard/test/extension.test.ts`: allow-once, session/project approval, denial, cancellation, UI failure, and headless fail-closed authority
- `test/transport.test.ts`: journal replay and concurrent command idempotency

Manual accessibility smoke check before release: complete select, confirm, input, and editor dialogs using keyboard only; verify initial focus, Tab/Shift+Tab containment, Escape cancellation, focus restoration, expiry/error announcements, and dialog title/description output in a screen reader.
