# pi-discover

Read-only repository search, local code indexing, historical-session search, and deferred-tool discovery for Pi.

## Install

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Package settings are available through Pylon Web.

## Tools and commands

| Tool or command | What it does |
| --- | --- |
| `search_tools({ query, limit? })` | Finds eligible deferred tools and asks Pylon to activate selected tools next turn |
| `search_sessions(...)` | Searches bounded redacted excerpts from saved Pi sessions |
| `session_stats({ sessionId, scope? })` | Returns bounded aggregate usage/tool statistics for one saved session |
| `rg`, `fd` | Bounded live text/file search |
| `relationship_graph(...)` | Heuristic definitions/calls grouped by file/location |
| `symbol_search`, `code_search`, `index_status` | Local SQLite symbol, lexical-code, and index status queries |
| `/discover-index refresh | rebuild | prune | status` | Maintain the current local index |

`search_tools` ranks inactive eligible tools deterministically, preferring exact names and advertised usage phrases. Pylon selects up to six and unblocked definitions become callable on the next turn. Repeated misses are cached for the turn; reset with `search_tools({ action: "reset" })`. Without Pylon coordination it reports unavailable and changes no tools. Pylon health metrics never contain raw queries.

Historical tools are deferred by default and must be loaded through `search_tools`. Session search defaults to saved sessions from the current working directory, excludes the active session, and needs `scope: "all"` for explicit cross-workspace search. Use `sessionId` for an exact requested session ID, with the requested subject in `query`. Default `text` searches user/assistant text; `tools` searches tool names and arguments, optionally linked results. Child activity from Scout, Grunt, and `spawn_agent` is optional and bounded; private spawn transcripts are never traversed. At most 200 sessions, 12 excerpts, and 1,200 characters per excerpt are scanned/returned. Text is untrusted, possibly stale, redacted best-effort, and retained in current session history; full paths and filenames are not returned.

`session_stats` returns no message text, arguments, results, paths, or telemetry context. It separates main and child usage/cost, reports combined totals and cache-read rate, and bounds completed-tool counts/errors/images.

## Live and indexed search

`rg` and `fd` can search any directory the Pi process can access, including outside the workspace, which can expose external names and contents to the model. `rg` falls back to `grep`; `fd` tries `fd`/`fdfind`, then POSIX `find`. Fallback behavior may include hidden/ignored paths and differs by local tool. Output is bounded; ripgrep skips files over 512 KiB and limits matches per file. `relationship_graph` is text heuristic, not semantic analysis; verify important results in source. It is deferred in the host but available to Repo Scout's child.

The code index is a machine-local SQLite database shared per canonical physical root and scoped back to each logical workspace. Git repositories use Git inventory and dirty paths; ordinary directories use native filesystem scans without requiring Git, ripgrep, or fd. Source files are never changed. Files over 512 KiB, binaries, symlinks, ignored files, and unsupported extensions are skipped. Refreshes and schema upgrades use transactions; SQLite uses WAL and bounded locking.

`symbol_search` is case-insensitive exact/prefix/substring matching with optional path, language, and kind filters. Extraction is heuristic. `code_search` is FTS5 lexical ranking, not semantic/embedding search, and defaults to ten one-line excerpts. Both refresh first and report bounded JSON/truncation counts. The database defaults to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-discover/index.sqlite
```

Pylon Web uses `~/.pylon/agent` as `<agent-dir>` by default. Standalone Pi uses its host agent directory, normally `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides the host that sets it.

Set `PI_DISCOVER_INDEX_PATH` to override it. `refresh` reconciles changes, `rebuild` fully indexes the current workspace, and `prune` removes records whose roots no longer exist.

### Indexing without Git

Outside a Git repository (or when Git is not installed), the canonical session working directory is the indexing root. `index_status` reports `mode: "filesystem"`; Git roots report `mode: "git"`. Other Git failures are errors, not permission to broaden scanning. Non-repository detection recognizes Git's English `not a git repository` diagnostic; unrecognized/localized errors fail closed. Creating Git metadata at the same root switches modes on the next refresh. A newly discovered parent Git root requires a new session rather than silently expanding filesystem scope.

Filesystem mode reads nested `.gitignore` rules, case-sensitively, only within the selected root. Defaults exclude hidden files/directories and `node_modules/`, `dist/`, `build/`, and `coverage/`. Root or applicable nested rules can override these defaults (for example `!.config/`); an excluded parent must be reopened before any child can be included. Git administrative data, links/junctions, and the index database and sidecars are always excluded. Nested repositories are ordinary subtrees in this mode. Git mode retains Git's existing inventory/ignore semantics.

Every filesystem refresh enumerates eligible paths and compares persisted size, high-resolution timestamps, and file identity. Unchanged metadata skips content reads; changed files are hashed and unchanged hashes retain symbol/FTS rows. On refresh, content verification becomes due after five minutes even if metadata matches—this is not a background timer. Set `filesystemVerifyIntervalMs` to `0` in package settings for content verification on every refresh (recommended for unreliable filesystem metadata); settings apply after reload. `rebuild` always rereads content and reconstructs symbols.

Inventory is checked again before committing. Incomplete scans, unreadable rules/files, unstable reads, or exhausted budgets fail without publishing partial filesystem content or advancing successful freshness. Searches await a successful refresh rather than silently serving stale results. Missing/excluded files are removed only after a complete successful reconciliation. Stable-handle reads and containment checks reduce races, but neither mode promises an atomic filesystem snapshot or security against hostile concurrent filesystem replacement. Ignored content is logically removed, not securely erased from SQLite/WAL/backups.

Filesystem scans are bounded to 100,000 visited entries, depth 128, 64 MiB of eligible source, 512 KiB per ignore file, and 8 MiB of ignore content in total. They use the search timeout as a cooperative refresh deadline (it cannot interrupt a stuck OS filesystem operation). Content preparation uses at most eight readers. Budgets fail explicitly rather than truncate inventory. Schema 3 indexes migrate additively without discarding cached content; earlier derived schemas rebuild. Watchers, disk-backed staging, and incremental directory caches are intentionally not used.
