# Workspaces and sessions

[Guide index](./README.md) · [Getting started](./getting-started.md) · [Surfaces](./surfaces.md) · [Safety and storage](./safety-and-storage.md)

## Projects and General

A **project** is a registered local directory. It groups its sessions and carries project-level workspace and policy settings. Add a directory with **Add project**; Pylon validates that it is a directory. From a project's menu you can rename it, reorder it, archive it, or remove it. Archiving hides it from normal navigation and can be reversed from **Archive**. Removing unregisters the project; treat it as distinct from archiving and review the confirmation before proceeding.

Use the project menu or drag/keyboard reorder controls to arrange projects. Reordering changes the sidebar order, not files on disk.

**General** is the built-in, non-project scope. Its sessions run from the current user's home directory, can use explicit paths available to that user, and do not use repository indexing. It is useful for general local tasks, not as a sandbox.

## Session lifecycle

Within a project or General, choose **New session**. The sidebar supports these session actions:

| Action | What it does |
| --- | --- |
| Switch | Selects a session as the current runtime. |
| Rename | Changes the displayed session name. |
| Pin | Keeps a session active; unpin it before deactivating it. |
| Activate / deactivate | Keeps an unselected session awake or lets an idle session sleep. A selected, running, queued, archived, or pinned session cannot simply be deactivated. |
| Reorder active | Changes the order of active sessions. |
| Archive / restore | Hides or restores a session without deleting it. |
| Delete | Removes the session after confirmation. |

Use the sidebar search to find sessions in normal project lists. **All sessions** is the normal workspace view; **Archive** separately searches archived projects and sessions and lets you restore them. Pinned sessions wake with the workspace; background sessions may sleep when idle and wake again when selected.

### Parent and child sessions

A session can be created with a parent session relationship. This is used for child-session workflows and is separate from merely placing two sessions in the same project. The parent relationship preserves the origin of the child; it does not make their files, queues, or running agent turns one shared runtime. The **Agents** reference shows delegated runs spawned by the current session; those runs are not interchangeable with a full project session.

A conversation **fork** creates a new session from a selected prompt. Choose a conversation fork, or a Timeline fork when a compatible checkpoint is available. Timeline forks require Timeline and a compatible checkpoint; the dialog explains when that option is unavailable.

## Conversation controls

Chat retains the session conversation. Load older history as needed, then use controls on a prompt or composer:

- Select the session **model** and supported **thinking** level; turn on **Plan mode** when available to plan the next prompt.
- Paste or attach supported images and text files, and refer to workspace files from the composer. Attachments become part of the session input—consider provider disclosure before uploading.
- While work is running, send a follow-up or queue a later prompt. Queued prompts can be restored into the composer or used to steer the run when offered.
- Use **Abort** to stop the current run. It does not promise to undo work already performed.
- Edit an earlier prompt or rewind to it. When Timeline is available, editing can offer rollback of matching files; review that choice before confirming.
- Fork from a prompt to explore a different continuation. A timeline-based fork uses the matching checkpoint only when Pylon says it is compatible.

The transcript shows tool activity and can expose attachments and per-turn file diffs. See [Surfaces](./surfaces.md) for the Inspector and Files views.

## Workspace modes

A project's effective policy determines where a new session starts. Set the global default in **Settings → Policy** and override it in the **Policy** reference for a project or session.

| Mode | Start location and behavior |
| --- | --- |
| **Local** | Works directly in the registered folder. It does not create a branch or linked worktree. |
| **Project folder** (checkout) | Uses a Pylon session branch in the registered checkout. |
| **Session worktree** | Creates an isolated linked Git worktree under the Pylon agent directory. |

The Git modes require a usable Git checkout. Project setup commands are saved per project and run only in newly created session worktrees, not in Local or Project-folder sessions. Check setup status and errors in the workspace information before relying on generated dependencies or setup output.

## Handoff and apply

For supported Git sessions, Files/workspace controls can move a session between the registered checkout and a session worktree. A handoff requires the session to be idle, no other session to own the project folder, and both locations to be compatible Git checkouts. Timeline may require checkpoint-portability confirmation before a move.

**Apply session changes** is different from handoff. It applies the bounded changed-file delta from a checkout or worktree session to the branch currently checked out in the registered project folder, after confirmation. The result is uncommitted and preserves the target's index and unrelated working changes where the merge can do so. A checkout session continues locally on that branch after a successful apply; a worktree session remains isolated.

Apply is unavailable when there are no changes, the session is not idle, another session owns the checkout, the target is not on a branch, repositories differ, or submodule changes need attention. Resolve conflicts or errors shown by the workspace result before continuing. This is not a replacement for reviewing Git status and committing your work.

## Practical flow

1. Register the repository and select **Session worktree** if you want isolation.
2. Set a setup command only if each new worktree needs local setup.
3. Start a session, work in Chat, and inspect **Files → Changes**.
4. When idle, either hand off the workspace or apply reviewed changes to the project checkout.
5. Commit, test, or discard changes with your normal local Git workflow.

For Git checkpoint requirements, see [Timeline](../../packages/pi-timeline/README.md). For confirmation behavior, see [Guard](../../packages/pi-guard/README.md) and [Safety and storage](./safety-and-storage.md).
