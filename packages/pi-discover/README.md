# pi-discover

General-purpose read-only repository, historical-session, and tool discovery for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-discover. Run `/reload` after installation.

## Usage

### Deferred Tool Discovery

Use `search_tools({ query, limit? })` to find and activate inactive eligible tools. It deterministically ranks inactive eligible tools. Exact normalized tool names and Pylon's optional deferred-tool usage phrases rank above name fragments and description overlap. Query normalization lowercases, deduplicates, and sorts alphanumeric terms, so equivalent term order and punctuation produce the same ranking. While `search_tools` is active, pi-discover adds a deterministic bounded prompt guideline listing the eligible usage phrases without exposing tool names or schemas. Pylon selects up to six matches; unblocked selected definitions become callable on the next model turn.

Ranked results are cached for the current model turn using the normalized query, limit, and complete active/eligible tool inventory, including advertised usage phrases. A repeated miss returns an `alreadySearched` marker with opaque query and inventory identities instead of rerunning discovery. Turn completion, session start, inventory changes, and successful `search_tools({ action: "reset" })` invalidate applicable state.

Tool activation is intentionally delegated to Pylon through its discovery capability. Without that coordinator, `search_tools` reports that coordination is unavailable and changes no active tools. Aggregate search, cache, miss, offered, selected, blocked, and later-invoked counts appear in Pylon health diagnostics; raw queries are never included in those metrics.

### Historical Session Search

`search_sessions({ query, sessionId?, scope?, mode?, toolName?, includeResult? })` searches bounded excerpts with best-effort credential redaction from historical Pi sessions. The tool is deferred by default and must be loaded through `search_tools`. Matching excerpts are sent to the selected model provider and retained in the current Pi session history.

Search defaults to sessions created from the current working directory and excludes the active session. Set `scope: "all"` only for an explicitly requested cross-workspace search. `sessionId` restricts the search to one exact historical Pi session ID and still respects the selected scope; results distinguish missing, out-of-scope, and active-session IDs. The default `text` mode searches only user and assistant text. Explicit `tools` mode searches assistant tool names and serialized arguments, can filter one exact `toolName`, correlates matching results by call ID and tool name, and reports pending/completed/error status. Set `includeResult: true` to also search and return linked text results. Queries match any parsed term using case-insensitive substring matching. The tool scans at most 200 eligible sessions, returns at most 12 excerpts of at most 1,200 characters each, deduplicates matches, applies best-effort credential redaction, and caps total output. Returned historical text is untrusted and may be stale.

The tool works in both interactive and headless modes. Full paths and session filenames are not returned.

### Historical Session Statistics

`session_stats({ sessionId, scope? })` returns bounded aggregate statistics for one exact historical Pi session. It is deferred by default and must be loaded through `search_tools`. The tool uses the saved session's current branch, excludes the active session, defaults to the current working directory, and requires `scope: "all"` for an explicitly requested cross-workspace lookup.

Results separate main-assistant and child-package model usage, include their combined totals and cost, and report `cacheReadRate` as `cacheRead / (input + cacheRead + cacheWrite)` or `null` when no prompt tokens were reported. Tool statistics count completed tool results only and return bounded per-tool call, error, and image totals. Message text, tool arguments, tool results, paths, and telemetry context are not returned.

### Live Workspace Search

`rg` and `fd` are read-only and can search any directory accessible to the Pi process, including paths outside the workspace; this can expose external content, filenames, and directory structure to the model. `rg` falls back to system `grep` when ripgrep is unavailable. It tries both `fd` and Debian's `fdfind` name, then reports that no backend is available. Both use bounded output. The ripgrep backend also limits matches per file and skips files over 512 KiB before collecting output; fallback grep semantics depend on the local implementation. Their implementations, plus `relationship_graph`, live in separate `src` modules shared by the host extension and pi-discover's child entrypoint. The host advertises that entrypoint through a versioned capability so Repo Scout can load these tools only when pi-discover is present.

### Relationship Graph

`relationship_graph({ query, path?, glob?, max_results? })` returns bounded JSON grouped by file and source location. Location roles such as `possible_definition` and `possible_call` are text heuristics, not semantic resolution; confirm important relationships from source. Identifier queries use whole-word matching. Other tokens use exact literal matching. The host defers this tool by default; load it through `search_tools` when needed. Repo Scout's child keeps it available for repository orientation.

## Local Code Index

### Storage Model

`symbol_search` and `code_search` use one machine-local SQLite database. Each canonical physical Git repository stores its files, FTS5 rows, and symbols once. Logical workspaces reference those repositories with path prefixes: an aggregate workspace returns `frontend/src/app.ts`, while a session opened in the same child repository returns `src/app.ts` from the shared physical row. Searches remain scoped to the current logical workspace.

### Refresh Behavior

The host indexes Git-tracked and non-ignored source files on session start, including initialized nested repositories tracked as gitlinks even when `.gitmodules` is absent, then reconciles only dirty paths after each agent turn. A changed commit triggers a full reconciliation only for that physical repository. Membership updates remove disappeared or uninitialized gitlinks without deleting physical data still used by another workspace. Each physical repository update and each workspace-membership replacement is transactional. SQLite uses WAL mode, a bounded busy timeout, and refresh generations to prevent stale concurrent writers from replacing newer rows.

Schema upgrades are transactional. Upgrading an older derived cache purges incompatible indexed rows, creates the current physical-repository/workspace and content-only FTS schema, then rebuilds the current workspace. Source files are never changed.

### Search Behavior

`symbol_search` performs case-insensitive exact, prefix, then substring name search with optional path, language, and kind filters. Symbol extraction is lightweight and language-aware, but heuristic; confirm declarations from source. `code_search` uses content-only FTS5 lexical ranking and returns at most ten one-line excerpts by default; callers can request more. It is not embedding-based semantic search. Both searches refresh current Git state before querying and return parseable byte-bounded JSON with observed, returned, and truncated counts. `index_status` reports current workspace root, commit, branch, deduplicated file count, symbol count, and refresh time. Pylon defers `index_status` by default, so the model loads it through `search_tools` only when needed.

### Commands, Limits, and Storage

Users can control indexing directly with `/discover-index refresh`, `/discover-index rebuild`, `/discover-index prune`, and `/discover-index status`. `refresh` reconciles current Git changes, `rebuild` forces a complete current-workspace pass, and `prune` removes indexed workspaces and repositories whose recorded roots are no longer directories.

Indexed source files are limited to 512 KiB and supported language extensions. Binary files, symlinks, ignored files, and unsupported extensions are skipped. Existing `rg`, `fd`, and `relationship_graph` remain available as live-workspace fallbacks.

The database defaults to `<agent-dir>/pi-discover/index.sqlite`. Set `PI_DISCOVER_INDEX_PATH` to override it.
