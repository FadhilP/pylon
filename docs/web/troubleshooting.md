# Troubleshooting

[Guide index](./README.md) · [Getting started](./getting-started.md) · [Settings](./settings.md) · [Safety and storage](./safety-and-storage.md)

## Pylon will not start or the page will not open

- Start from a terminal and read the startup message. The normal address is `http://127.0.0.1:3141`.
- If the port is in use, stop the process using it or start with a free port:

  ```sh
  PYLON_PORT=3142 pylon
  ```

  Use the Windows environment-variable syntax in a Windows shell when applicable.

- Check that `PYLON_PORT` is a valid port number and that `PYLON_CWD`, if set, names a usable directory.
- Pylon is intentionally loopback-only. Open the printed `127.0.0.1`/`::1` URL from the same machine; do not try a LAN IP or hostname.
- If startup reports a storage or package error, do not delete agent data first. See [migration and recovery](./safety-and-storage.md#backups-migration-and-recovery).

## Disconnects and reconnection

A browser refresh or temporary local connection loss can disconnect the UI from the local server. Confirm that the `pylon` process still runs, then reload the same printed loopback URL. If the process exited, restart it from the intended project directory.

After reconnecting, verify the selected session and its generation/state before sending another prompt. A session may be sleeping, unavailable, or replaced after a workspace/package operation. Reopen a terminal drawer if it closed: terminals are tied to a selected ready session and close when that session deactivates or becomes unavailable.

## Provider, model, and authentication problems

- Open **Settings → Providers**. Connect the provider with its offered sign-in or key flow. Providers marked external are configured outside Pylon.
- If disconnect is disabled, make active sessions idle first.
- Open **Settings → Models** and ensure the model is visible. Hiding only removes it from selectors; it does not create credentials or model access.
- If no models are listed, connect a provider first. If an agent package cannot select a model, review **Agent models** and that package's model settings.
- Do not paste API keys into Chat. Cancel a failed flow and retry from the provider tab; provider-side account, subscription, or model-entitlement errors must be fixed with that provider.

## A tool, package, or surface is unavailable

First inspect **Settings → Packages**. A package can be disabled, enabled but failed to load, or active without a currently usable capability. Read its package status/error and enable it only after its prerequisites are met.

Many optional tools are **deferred**. Deferred does not mean broken: the tool is not initially exposed and may need the package's activation path, often `search_tools`. A global/project/session tool policy can also disable it. Check **Inspector → Tools** for effective overrides and [Settings](./settings.md#packages) for inheritance.

A surface also needs a ready session. Database requires enabled/available StateQL; Browser requires available Helios; Timeline needs enabled Timeline and compatible Git state; Memory depends on Continuity/Papercut capability. Return to Chat or start/refresh a session after correcting configuration.

## Extensions, trust, and reload

Open **Settings → Extensions** to inspect resolved extensions and load errors. Project-scoped extension changes require project trust. Trust only permits trust-requiring project resources; it does not sandbox code. Review extension sources because they execute arbitrary code with the server's permissions.

After an extension/package configuration change, use **Reload extensions** when the UI offers it, then inspect any load error again. If the project cannot be trusted or an extension remains unavailable, remove/disable the problematic extension rather than editing Pi configuration files blindly. See [Safety and storage](./safety-and-storage.md#trust-isolation-and-authority).

## Browser, Android, and database prerequisites

**Browser (Helios)**

- Enable/configure [Helios](../../packages/pi-helios/README.md), then ensure a session is ready.
- Helios never downloads a browser automatically. Install compatible Chrome through its documented command if it is missing.
- The Pylon Browser surface controls only Helios-owned browsers. Attached user browsers are tool-only and are not mirrored in the panel.

**Android (Helios)**

- Install and configure user-managed Android SDK `platform-tools`, `emulator`, Java, and an existing AVD; set `ANDROID_SDK_ROOT`/`ANDROID_HOME` where needed.
- In the Helios package settings, check Android tooling status and install/repair managed Appium tooling after confirmation. This does not create an AVD.
- Run `/helios doctor android` in a suitable Pi session for detailed prerequisite status.

**Database (StateQL)**

- Enable [StateQL](../../packages/pi-stateql/README.md) and activate its deferred tool when needed.
- Use a valid profile or complete database URL from a credential environment variable. A bare password or bare SQLite path is not a `secret_env` source.
- Use `STQL_HOME` only when you intentionally need a different StateQL data directory. Review confirmation/credential errors in the current session rather than resending secrets in Chat.

## Workspaces, Git, Timeline, and Verify

- A project must be a real directory. Git workspace modes need a usable Git checkout; Local mode does not create a branch or worktree.
- If worktree setup fails, inspect the workspace setup error. The saved setup command runs only in newly created Session worktrees, so repair the command and create a new worktree session if necessary.
- Handoff/apply requires an idle session, compatible repository, and no other session owning the project checkout. Apply also needs changed files, a target branch, and no unresolved submodule limitation. Read the precise unavailable reason in Files/workspace state.
- Timeline needs a non-bare repository with an existing `HEAD` and safe Git state. Active/unmerged Git operations, incompatible checkpoints, or repository identity changes can make checkpoint/restore/fork fail closed. See [Timeline](../../packages/pi-timeline/README.md).
- Verify runs project checks according to the effective policy and available checks. Inspect its reported result and project prerequisites; do not assume a missing package script or a failed check can be fixed by changing a Web toggle. See [Verify](../../packages/pi-verify/README.md).

## Storage migration or override problems

Pylon Web defaults to `~/.pylon/agent` and migrates legacy `~/.pi/agent` by copying it when the default destination is absent. If migration fails, preserve both directories, read the warning, and retry:

```sh
pylon migrate
```

If `PI_CODING_AGENT_DIR` is set, confirm which directory Pylon is actually using. It overrides **Pylon Web** storage. Independently installed packages use their host Pi directory—normally `~/.pi/agent`—unless that host has its own override. Do not fix a Pylon Web problem by deleting or merging the host Pi directory. See the [storage table](./safety-and-storage.md#storage-scopes).

## Diagnostics: what to run and where to look

Run this in a Pi terminal/session to check package health, models, credentials, and dependencies:

```text
/pylon doctor
```

Also inspect:

1. The terminal that launched `pylon` for startup, migration, port, and server errors.
2. **Settings → Packages** for package state, configuration, and load errors.
3. **Settings → Extensions** for trust state, extension load errors, and reload controls.
4. **Inspector → Overview**, **Policy**, **Tools**, and **Timeline** for session state, effective policy, tool exposure, and checkpoint status.
5. Files/workspace status for setup, handoff, apply, conflict, and changed-file information.
6. The current Chat transcript for provider, tool, confirmation, or verification results.

When asking for help, include the visible error, operating system, Pylon version, whether `PI_CODING_AGENT_DIR` is set, and the relevant package/doctor output—but redact credentials, database URLs, private prompts, and sensitive tool output.
