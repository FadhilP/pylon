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

For focused tests and direct TypeScript diagnostics, run Node from `platform/web` so runner options stay before the test path and the repository's native TypeScript transform is used:

```sh
cd platform/web
node --experimental-transform-types --test-concurrency=2 --test --test-name-pattern="terminals stay attached per session until that session deactivates" test/server-transport.test.ts
node --experimental-transform-types --input-type=module --eval "import { SessionIndex } from './src/server/pi/session-index.ts'; console.log(SessionIndex.name)"
```

Node's native transform does not load `.tsx`. Tests that need a client module can use the already-installed Vite transform, which handles TSX and extensionless production imports:

```ts
```ts
import { createServer } from "vite";
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try { const module = await vite.ssrLoadModule("/src/client/example.tsx"); }
finally { await vite.close(); }
```
## Session workspaces

The sidebar also includes a built-in **General** scope below Projects. General sessions are rooted at the current OS user's home directory, can search and edit files available to that user through explicit paths, and do not use repository indexing. Normal Guard protections still apply.

New sessions use the project's explicit workspace policy. Local works directly in the registered folder without changing branches, Project folder uses a Pylon session branch in that checkout, and Session worktree creates a linked worktree under the agent directory. Project setup commands run only inside newly created worktrees.

Project-folder and Session-worktree sessions can apply their bounded session delta to the branch currently checked out in the registered project folder. The merge preserves that branch's index and unrelated working changes, and leaves the applied result uncommitted. Project-folder sessions continue as Local afterward; Session-worktree sessions remain isolated.

The Files right panel exposes bounded, read-only file content and per-session diffs. “Move to project checkout” parks the checkout's branch, index, and working state and moves the session branch there; “Move to worktree” reverses that operation. Timeline must confirm checkpoint portability before either handoff.

When `pi-helios` is active, the Browser right panel can launch or take exclusive direct control of a Helios-owned browser. The screenshot-backed viewport supports pointer, keyboard, wheel, navigation, resize, and tab controls. Attached user browsers remain tool-only; panel frames are local, ephemeral, and served with `Cache-Control: no-store`.

`npm run verify` runs type checking, Node tests, and the production build. Before release, also exercise the session switcher, image paste/retry flow, responsive layout, and remote dialogs with keyboard-only navigation.
