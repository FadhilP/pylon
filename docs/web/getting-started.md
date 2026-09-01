# Getting started

[Guide index](./README.md) · [Workspaces and sessions](./workspaces-and-sessions.md) · [Safety and storage](./safety-and-storage.md)

## Requirements

- Node.js 22.19.0 or later.
- A local folder in which to work. Git is needed for Git-backed workspaces and Timeline, but not for a basic local session.
- A provider account or credential for the model you intend to use.

## Install and start

Install the published CLI globally, then start it from the project directory:

```sh
npm install --global @fadhilp/pylon
cd /path/to/project
pylon
```

Open the printed address, normally `http://127.0.0.1:3141`. Pylon Web binds only to `127.0.0.1` or `::1`; it is not a LAN or remote server. Configure a provider and select models in **Settings** before asking an agent to work. See [Settings](./settings.md).

The root command starts with the current directory unless `PYLON_CWD` is set. It creates or selects a project for that directory when possible; use the project picker to add further folders.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PYLON_CWD` | Starting project directory. Defaults to the current directory for the installed CLI. |
| `PYLON_PORT` | Loopback port. Defaults to `3141`; choose a free valid port if it is occupied. |
| `PYLON_NO_UPDATE_CHECK=1` | Disables the startup update check. |
| `PI_CODING_AGENT_DIR` | Overrides Pylon Web's agent-data directory. This changes Pylon Web storage scope; see below. |

## First project and session

1. In the sidebar, choose **Add project** and select a directory, or use the automatically opened directory.
2. Expand the project and choose **New session**.
3. In Chat, select the session model and thinking level, optionally enable Plan mode, then send a focused request.
4. Review progress in Inspector and changed files in **Files**. If the session uses a Git workspace, apply or hand off changes only after reviewing them.

The built-in **General** scope is different from a registered project: it starts at your OS home directory and has no repository indexing. Use explicit paths when working there.

## Storage and migration

Pylon Web normally uses `~/.pylon/agent`. On first start it copies legacy `~/.pi/agent` state into that location when the destination does not already exist. The original legacy directory is retained; it is not moved or deleted.

If migration could not finish, Pylon can temporarily use the legacy directory and prints a warning. Retry the default-path migration with:

```sh
pylon migrate
```

`PI_CODING_AGENT_DIR` is independent of this migration: when set, it is Pylon Web's chosen agent directory instead of `~/.pylon/agent`. Do not assume it also relocates separately installed Pi packages. Packages installed into a host Pi use that host's agent directory—normally `~/.pi/agent`—unless that host is separately started with its own `PI_CODING_AGENT_DIR`.

See the complete path and backup guidance in [Safety and storage](./safety-and-storage.md).

## Updating

Update the global package with your normal npm workflow, then start a new `pylon` process. Existing local data is retained; the automatic migration only fills a missing default Pylon directory and does not overwrite an existing one. If a storage migration remains unresolved, fix or back up the involved directories before retrying `pylon migrate`.

## Next steps

- Organize work in [Workspaces and sessions](./workspaces-and-sessions.md).
- Learn the views in [Surfaces](./surfaces.md).
- Set package and safety defaults in [Settings](./settings.md).
