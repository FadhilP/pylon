# Pylon Web

Local React client and loopback-only Node host for Pylon.

```sh
npm install
npm run dev --workspace @pylon/web
```

The development server hosts the Pi runtime, same-origin API, event stream, and Vite middleware at `127.0.0.1:3141`. Use `PYLON_CWD` or `PYLON_PORT` to override the defaults.

## Structure

- `src/client`: React UI, browser API client, event store, and styles.
- `src/shared`: bounded protocol types and pure transcript projections used by both sides.
- `src/server/http`: loopback transport, request validation, security, and static assets.
- `src/server/pi/session-runtime.ts`: one SDK-backed session runtime.
- `src/server/pi/runtime-coordinator.ts`: selected-session routing and concurrent runtime lifecycle.
- `src/server/pi`: package discovery, remote UI, session indexing, and read-model projections.

The coordinator keeps running sessions alive in the background. An unselected session that was only viewed sleeps after one minute; one that received input sleeps after 30 idle minutes. Switching to an awake session reuses its runtime.

## Commands

```sh
npm run typecheck --workspace @pylon/web
npm test --workspace @pylon/web
npm run build --workspace @pylon/web
npm run verify --workspace @pylon/web
npm run start --workspace @pylon/web
```

## Session workspaces

The first accepted prompt in a new Git-backed session lazily creates a Pylon-owned linked worktree under the agent directory. Its synthetic baseline includes the registered checkout's tracked and non-ignored untracked state, so the Files panel reports only session changes. Existing sessions remain checkout-bound until explicitly moved. Project setup commands run only inside newly created worktrees; sessions are never merged back automatically.

The Files right panel exposes bounded, read-only file content and per-session diffs. “Move to project checkout” parks the checkout's branch, index, and working state and moves the session branch there; “Move to worktree” reverses that operation. Timeline must confirm checkpoint portability before either handoff.

`npm run verify` runs type checking, Node tests, and the production build. Before release, also exercise the session switcher, image paste/retry flow, responsive layout, and remote dialogs with keyboard-only navigation.
