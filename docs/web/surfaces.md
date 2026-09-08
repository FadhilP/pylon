# Surfaces and references

[Guide index](./README.md) · [Workspaces and sessions](./workspaces-and-sessions.md) · [Settings](./settings.md) · [Troubleshooting](./troubleshooting.md)

Pylon Web changes views around the selected session. A view can be absent when its package, tool, project state, or session is unavailable. Enable/configure the relevant package in **Settings → Packages**, then start or refresh a session as needed.

## Chat and composer

**Chat** is the main conversation. The composer sends a prompt, queues a follow-up while work is running, and offers controls for the current session model and supported thinking level. **Plan mode** is available only when Continuity's planning capability is available.

The composer accepts supported image and text-file attachments and workspace-file references. It also exposes follow-up, queue, abort, edit, rewind, and fork workflows described in [Workspaces and sessions](./workspaces-and-sessions.md). Tool output, generated text, and attachments can appear in conversation history and may be sent to the selected provider.

## Files and Changes

**Files** is session-aware. It lists workspace files, shows current/base/diff content when available, and marks changed paths. Opening a file from the workspace explorer defaults to **Working copy**, even when that file has changes; opening from **Changes** keeps the diff view. Selecting an already-open tab restores its chosen view. Content can be unavailable for deleted, binary, oversized, or otherwise unsupported files. The Files view also exposes the workspace's Git status, setup state, handoff options, and reviewed apply workflow.

The **Changes** Inspector reference is a compact changed-file and diff view when Files is not the main surface. **Turn Diff** opens a changed-file view attached to an individual conversation turn. These are inspection tools, not a substitute for Git status or a full editor.

### Editing and file/folder actions

In the live **Working copy** view, supported text files are editable directly—no separate edit mode is needed. Use **Save** or Ctrl/Cmd-S while the editor is focused. **Discard** reloads the working copy after confirming any unsaved changes. Clean buffers refresh from disk; unsaved drafts keep their original conflict version across tabs and session switches. Drafts are memory-only and do not survive a page reload. Pylon asks before closing dirty tabs and requests a browser warning before leaving with unsaved text. History, baseline, diff, and unsupported-file views remain read-only.

Editing retains the code viewer's Shiki syntax colors, typography, line numbers, selection gutters, and inline notes. CodeMirror handles text input immediately; Shiki runs in a background worker, reusing unchanged line states and sending back only visible syntax spans. Colors and Git gutters can briefly lag typing without holding up input. Obsolete results are ignored; if highlighting fails, plain-text editing remains available. Ctrl/Cmd-S preserves the caret and undo history. Notes still match captured source hashes; changing the text immediately removes stale note markers rather than moving a saved note onto different code.

Working-copy Git gutters compare the current text, including unsaved edits, with Git's index: green marks additions, blue marks replacements, and red triangles mark deletion boundaries. They are separate from saved-history attribution. Staging/unstaging refreshes the comparison on workspace updates, window focus, and every 30 seconds while visible, without rebasing dirty drafts. Untracked files compare against empty text; non-Git, ignored, conflicted, filtered, or unsupported index files have no Git markers. Large comparisons are bounded and may show an unavailable notice. These gutters are indicators, not staging or revert controls.

Supported working-copy text loads without waiting for Git comparison data or a repository snapshot. After a save, the server confirms the written bytes and returns their conflict version before refreshing repository status in the background. A following save uses that confirmed version; if confirmation fails, the draft remains unsaved and the error asks you to inspect the working copy. Repository counts and history may catch up after the editor reports Saved.

Right-click a file or folder for **Rename**, **Move…**, and **Delete…**; folders also offer **New File** and **New Folder**. Right-click empty tree space, or use **New…**, to create at the workspace root. **Actions…** operates on the selected/focused tree entry and is available to touch users; Shift-F10 or the Context Menu key opens its menu from keyboard tree navigation. New names use existing parent folders; Move takes the complete new workspace-relative path. Empty folders remain visible, but Git does not track or apply empty directories.

Operations write only to the selected session's actual workspace. Worktree changes stay isolated until separately applied. Saving is allowed while sessions and delegated runs are working; creating, renaming, moving, and deleting still require all sessions and delegated runs to be idle. Avoid simultaneous writes to the same file. Saves and destructive actions recheck content versions and reject stale requests without discarding drafts. Source/destination collisions are rejected when observed; these checks are optimistic, not an atomic cross-process lock. Concurrent external writers and filesystem-link swaps cannot be fully excluded by portable filesystem APIs.

Editing supports valid UTF-8 text up to 1 MiB, preserving a BOM and consistent LF/CRLF endings. Binary, invalid UTF-8, mixed/legacy line endings, hard-linked, and read-only files cannot be saved here. Saves use a same-directory temporary file with metadata-preserving native operations: Windows PowerShell ACL copying and `File.Replace`, or Linux GNU `cp` with explicit mode/ownership/xattr preservation. Missing tools or preservation failures reject the save without a metadata-losing fallback. Existing-file saves and folder moves on other operating systems are currently unavailable. Symlinks, special files, ambiguous Windows names, protected metadata, and nested repositories/submodules cannot be mutated here. Folder operations inspect at most 2,000 entries / 64 MiB, with depth/time limits; larger operations require local filesystem tools.

Delete is **permanent**, not a Recycle Bin operation, and requires confirmation. Non-empty folders are deleted from a revalidated manifest; unexpected entries stop deletion rather than being recursively swept away. A failed multi-entry deletion can be partial—refresh and inspect before retrying. Save/discard affected drafts before renaming, moving, or deleting. Manual operations do not run an agent tool or create an automatic Timeline checkpoint; they are not attributed to an agent turn. Later Timeline restore/rollback can replace manually edited files, so review restore confirmations and keep backups.


### Code notes

Select new-side source lines in a file or diff, then choose **Note selected lines**. Drag over code or line numbers, or focus the viewer and use Arrow keys with Shift to extend a selection. Deleted-side lines and selections crossing folded context or file boundaries cannot create notes. Violet brackets are separate from line attribution; click a bracket to expand its note.

**Save note** persists a private draft in Pylon's server-owned SQLite database, scoped to the project and session. Saved notes survive restarts and browser changes. The **Notes** Inspector groups them by file, and the explorer shows note counts independently of Git changes. Use **Refresh notes** for edits made in another browser; active pages also refresh periodically. Concurrent edits are revision-checked, never silently overwritten.

The Notes inventory is ordered by path and line. Selecting a note reveals its matching source and opens the inline card; it never reuses captured coordinates against changed code. If the source is not open or no longer matches, Notes shows the saved snapshot instead. File headers open the current file without replaying the note's coordinates. Selecting a note and including it in the next message are separate actions.

Tick **Include with next message** to attach notes to the normal chat composer, or send them directly from Notes with an optional message. They become ordinary visible user prompts containing each note, full file path, source revision, line range and captured code—not hidden tool messages. Source is checked before submission; changed, unavailable or historical source requires confirmation to send the original captured excerpt. Queued input is frozen at submission, not reread when execution starts. An uncertain delivery error requires checking chat and the queue before sending again. The existing prompt queue is memory-only; saved notes remain in SQLite.

One unfinished note editor is retained in page memory while switching files or versions; **Continue draft note** opens it in Notes when its inline location is gone. Save it before reloading or closing the browser. Attachment choices are also page-local and clear after accepted submission; notes themselves remain until explicitly deleted. Deleting the session or project deletes its saved notes, without rewriting already-sent chat messages.

Notes never automatically move, resolve or acquire after-turn statuses. A source mismatch leaves the original snapshot available in Notes rather than putting a bracket on unrelated lines. Renames and forks do not transfer notes. Limits are 200 saved notes per session, 4 KiB per note body, 24 KiB per captured excerpt, and 64 KiB for the complete outgoing prompt. Storage and size failures are explicit; no saved notes are silently evicted. See [Safety and storage](./safety-and-storage.md) for the database location and backup boundary.


### Workspace search

The explorer and Changes file list offer **Path** and **Text** modes. Path filters as you type; Text runs on Enter or **Search**, with independent query text. Text results can be shown in a folder tree or grouped by file. Selecting a matching line opens the working copy at that location.

The top-bar **Search** button opens an alternative popup with **All**, **Files**, **Text**, **Symbols**, and **Actions** tabs. Ctrl/Cmd-P opens Files; Ctrl/Cmd-Shift-F opens Text. Double Shift outside text inputs and the terminal restores the last tab. Browser/OS shortcuts may take precedence; the button is always available for a ready session. A leading `#` switches to Symbols. Tab reaches controls normally; Ctrl-Tab switches sources. Arrow keys in the input move the preview, Enter opens the selection, and Escape closes the popup.

Popup Text searches after a 220 ms pause and cancels superseded requests. **Stop** retains the partial results. **Open in panel** (Shift-Enter) pins a snapshot that survives closing the popup; pinned results remain clickable, and **Search again** reruns the saved query. Changing sessions clears search state. All combines ranked files, symbols, and actions, but does not launch text search. Actions reuse existing controls; applying changes still requires review and confirmation.

Both text-search entry points use the selected session's bounded workspace inventory, not arbitrary external paths. Searches are literal by default, with case, whole-word, regex, and comma-separated include-glob options (`*.ts, src/**`). Ripgrep is preferred; if missing, grep is used automatically and an informational notice appears. Regex syntax then follows grep rather than ripgrep. Neither binary available is an error, not an empty result.

Results stream in batches and are limited to 100 matching files, 20 matching lines per file, bounded snippets/output, and a 30-second search budget. Files over 512 KiB, links, and unavailable/unsupported entries are excluded; the existing inventory is capped at 10,000 files. Counts describe returned matching lines, not every occurrence or every file scanned. Limits and partial results are reported explicitly. The **Changed** filter and preview markers describe changes since the session baseline, not proof of who authored them.

Symbols use Discover's heuristic index, ranked by exact name, prefix, camel-hump initials (`bWT` → `buildWorkspaceTree`), then substring. They refresh before querying and may wait on indexing; the other sources remain usable. Symbol lists are capped at 200 entries, including an empty-query browse. Search does not run an agent turn or write files. Replace-across-files is not included.


### File history

In **Files**, use the history timeline to inspect saved versions without changing the workspace. Its stops support Left/Right and Home/End keyboard navigation. **Session** shows checkpoints on the current conversation branch; **All history** also shows Git commits. **Baseline** remains a separate anchor, and **Live** returns to the actual working copy. For a Git commit, **Diff** compares its parent with that selected commit. For a session checkpoint, **Diff** compares the session baseline with the selected checkpoint. **Show this change** shows only that version's change. **About this history** is available in the collapsible footer below the code.

The selected version title opens a newest-first picker, including Baseline and Live. Arrow keys, Home/End and Escape navigate and dismiss it. Selected-change line counts are shown only when both source versions were readable; previously visited counts can also appear in the picker. Checkpoint gap counts include only verified unchanged snapshots, while unknown Git gaps remain unnumbered. Historical source lines wrap without changing their saved line numbers; the working-copy editor is unaffected.

The coloured gutter attributes saved lines to checkpoints or Git commits. Selecting a version highlights its surviving lines; clicking an attributed stripe selects its version when it is in the loaded history. Deleted diff lines retain their earlier owner. Baseline/preexisting edits and unavailable attribution are left unassigned rather than credited to a later turn. Live edits are not attributed. Checkpoint verification describes the captured workspace, not an independent test of this file.

Git history and blame follow first parents, including committed renames, anchored before the session baseline or at HEAD when no baseline exists. Synthetic Pylon baseline commits are not presented as authored project history. Session renames begin a new path history; checkpoints from another conversation branch or session are excluded. Git history remains usable without Timeline checkpoints.

Reads are bounded: up to 200 recent session checkpoints, Git history in increments of 40 up to 200 commits, and UTF-8 versions up to 1 MiB / 20,000 lines. Missing objects, binary files, unsupported paths, and work limits have explicit unavailable states. Earlier or missing checkpoint ownership is never inferred. No file restore or Git checkout action is offered here.

## Browser

The **Browser** surface appears only when [Helios](../../packages/pi-helios/README.md) is active and browser capability is available for the session. It needs a ready session. It can launch or directly control a Helios-owned browser through a local, temporary mirror; starting direct control pauses agent browser actions while the panel owns the control lease.

Helios does not automatically download a browser. Install compatible Chrome through Helios when required. User-attached browsers remain tool-only: Pylon Web does not mirror or directly control them. Browser snapshots and screenshots can contain sensitive page content; screenshots cannot be reliably redacted. See [Safety and storage](./safety-and-storage.md).

Helios also supports Android workflows, but those are not a Browser-surface prerequisite. Android needs user-managed Android SDK tools, Java, and an existing AVD. Pylon can install its managed Appium/UiAutomator2 tooling after confirmation in **Settings → Packages → pi-helios**; it does not create an AVD or modify global npm. See [Helios](../../packages/pi-helios/README.md).

## Database

The **Database** surface appears only when [StateQL](../../packages/pi-stateql/README.md) is enabled and database capability is available in the current session. It provides a bounded local workspace/history view: connection metadata, transaction ownership, recent handles and operations, and explicitly expanded result pages. It is not a general database administration console.

StateQL controls remain authoritative. Connection changes, writes, plan application, transactions, and profile removal require interactive confirmation. SQL, parameters, and returned rows can enter Pi history and may be sent to the selected provider. Pylon Web may request a credential in a masked dialog for supported StateQL flows; see [Safety and storage](./safety-and-storage.md).

Connections can be created or edited without placing passwords in command payloads. Optional password storage uses the OS credential vault; reconnecting still requires approval. The object browser loads supported tables, views, functions, triggers, enums, collections, or Redis keys on demand. Definitions open separately from table data. Statement history hides internal discovery/management activity by default; enable **Internal activity** for diagnostics.

Result controls search, filter, sort, and hide columns within loaded rows only. Results and connections expose short random aliases when supported by StateQL; their immutable IDs remain valid. Connection aliases are display references, while connection isolation and workspace scopes continue to use canonical IDs. Editable tables stage cell changes locally, then review and apply a single guarded batch. Conflicts or uncertain outcomes require reloading rather than silently retrying. Redis supports a bounded allowlist of reads and single-key writes, not arbitrary commands, SQL transactions, or table editing. **System** appearance follows the OS; explicit Light/Dark choices and syntax colors apply across the workspace.

## Terminal

**Terminal** is an ambient drawer for the selected ready session. It starts a local shell in that session's workspace: PowerShell on Windows, or `$SHELL`/`/bin/sh` elsewhere. It is one terminal per session and closes when that session deactivates, becomes unavailable, exits, or the server closes. A terminal uses your local account and its normal permissions; it is not a sandbox and is separate from agent tool confirmations.

## Inspector references

The Inspector rail follows the selected session. Depending on packages and state, it contains:

| Reference | Use | Availability |
| --- | --- | --- |
| **Overview** | Live session state, task/work progress, and usage summary. | Available for a session. |
| **Policy** | Project and session behavior; global defaults are in Settings. | Available for a session. |
| **Timeline** | Recoverable checkpoints for the current run. | Requires enabled Timeline and a compatible Git workspace. |
| **Memory** | Durable project context and workflow-friction records. | Requires Continuity memory or Papercut capability. |
| **Notes** | Private code-range drafts to include in ordinary chat messages. | Available for a ready session. |
| **Tools** | Project/session overrides for registered tools. | Available for a session. |
| **Changes** | Touched files and diffs. | Hidden while Files already shows it. |
| **Agents** | Delegated runs spawned by the session. | Available; may be empty. |
| **Compaction** | Inspect the current compaction workflow when it is present. | Contextual to compaction activity. |
| **Attachments** | Inspect message attachments. | Contextual to a message with attachments. |
| **Turn Diff** | Inspect changed files from one transcript turn. | Contextual to a turn with changes. |
| **Chat** | The same conversation while another main surface is open. | Shown when Files, Browser, or Database displaces Chat. |

Timeline requires a non-bare Git repository with an existing `HEAD` and a safe Git state. Review [Timeline](../../packages/pi-timeline/README.md) for checkpoint and restore limits. Memory behavior comes from [Continuity](../../packages/pi-continuity/README.md); delegated runs depend on their configured packages.

## Workspace views

- **All sessions** returns to the project/session navigator.
- **Archive** searches archived projects and sessions and restores them.
- **Usage** presents usage information for the workspace.

These workspace views do not replace the selected session's Chat or Inspector state. Return to a session to act on it.
