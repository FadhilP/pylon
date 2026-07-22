# pi-discover

General-purpose read-only repository and tool discovery for [Pi](https://pi.dev).

## Usage

`search_tools({ query, limit? })` deterministically ranks inactive eligible tools. Exact normalized tool names and optional `aliases` or `capabilities` metadata rank above name fragments and description overlap. Query normalization lowercases, deduplicates, and sorts alphanumeric terms, so equivalent term order and punctuation produce the same ranking. Pylon selects up to six matches; unblocked selected definitions become callable on the next model turn.

Ranked results are cached for the current model turn using the normalized query, limit, and complete active/eligible tool inventory. A repeated miss returns an `alreadySearched` marker with opaque query and inventory identities instead of rerunning discovery. Turn completion, session start, inventory changes, and successful `search_tools({ action: "reset" })` invalidate applicable state.

Tool activation is intentionally delegated to Pylon through its discovery capability. Without that coordinator, `search_tools` reports that coordination is unavailable and changes no active tools. Aggregate search, cache, miss, offered, selected, blocked, and later-invoked counts appear in Pylon health diagnostics; raw queries are never included in those metrics.

`rg` and `fd` are read-only workspace searches. They use bounded output and direct models to built-in `grep` or `find` when their optional executables are unavailable. Their implementations, plus `relationship_graph`, live in separate `src` modules shared by the host extension and pi-discover's child entrypoint. The host advertises that entrypoint through a versioned capability so Repo Scout can load these tools only when pi-discover is present.

`relationship_graph({ query, path?, glob?, max_results? })` returns bounded JSON containing query, file, and source-location nodes joined by `contains` and `mentions` edges. Location roles such as `possible_definition` and `possible_call` are text heuristics, not semantic resolution; confirm important relationships from source. Identifier queries use whole-word matching. Other tokens use exact literal matching.

## Local code index

`symbol_search` and `code_search` use one machine-local SQLite database. Each canonical physical Git repository stores its files, FTS5 rows, and symbols once. Logical workspaces reference those repositories with path prefixes: an aggregate workspace returns `frontend/src/app.ts`, while a session opened in the same child repository returns `src/app.ts` from the shared physical row. Searches remain scoped to the current logical workspace.

The host indexes Git-tracked and non-ignored source files on session start, including initialized nested repositories tracked as gitlinks even when `.gitmodules` is absent, then reconciles only dirty paths after each agent turn. A changed commit triggers a full reconciliation only for that physical repository. Membership updates remove disappeared or uninitialized gitlinks without deleting physical data still used by another workspace. Each physical repository update and each workspace-membership replacement is transactional. SQLite uses WAL mode, a bounded busy timeout, and refresh generations to prevent stale concurrent writers from replacing newer rows.

Schema upgrades are transactional. Upgrading the derived cache from schema 0 or 1 purges old indexed rows whose aggregate ownership is ambiguous, creates the physical-repository/workspace schema, then rebuilds the current workspace. Source files are never changed.

`symbol_search` performs case-insensitive name search with optional path, language, and kind filters. Symbol extraction is lightweight and language-aware, but heuristic; confirm declarations from source. `code_search` uses FTS5 lexical ranking and returns source excerpts. It is not embedding-based semantic search. `index_status` reports current workspace root, commit, branch, deduplicated file count, symbol count, and refresh time. Pylon defers `index_status` by default, so the model loads it through `search_tools` only when needed.

Users can control indexing directly with `/discover-index refresh`, `/discover-index rebuild`, and `/discover-index status`. `refresh` reconciles current Git changes, while `rebuild` forces a complete current-workspace pass.

Indexed source files are limited to 512 KiB and supported language extensions. Binary files, symlinks, ignored files, and unsupported extensions are skipped. Existing `rg`, `fd`, and `relationship_graph` remain available as live-workspace fallbacks.

The database defaults to `<agent-dir>/pi-discover/index.sqlite`. Set `PI_DISCOVER_INDEX_PATH` to override it.
