# pi-discover

General-purpose read-only repository and tool discovery for [Pi](https://pi.dev).

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

### Live Workspace Search

`rg` and `fd` are read-only workspace searches. They use bounded output and direct models to built-in `grep` or `find` when their optional executables are unavailable. `rg` also limits matches per file and skips files over 512 KiB before collecting output. Their implementations, plus `relationship_graph`, live in separate `src` modules shared by the host extension and pi-discover's child entrypoint. The host advertises that entrypoint through a versioned capability so Repo Scout can load these tools only when pi-discover is present.

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
