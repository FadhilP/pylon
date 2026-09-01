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
| `/discover-index refresh|rebuild|prune|status` | Maintain the current local index |

`search_tools` ranks inactive eligible tools deterministically, preferring exact names and advertised usage phrases. Pylon selects up to six and unblocked definitions become callable on the next turn. Repeated misses are cached for the turn; reset with `search_tools({ action: "reset" })`. Without Pylon coordination it reports unavailable and changes no tools. Pylon health metrics never contain raw queries.

Historical tools are deferred by default and must be loaded through `search_tools`. Session search defaults to saved sessions from the current working directory, excludes the active session, and needs `scope: "all"` for explicit cross-workspace search. Use `sessionId` for an exact requested session ID, with the requested subject in `query`. Default `text` searches user/assistant text; `tools` searches tool names and arguments, optionally linked results. Child activity from Scout, Grunt, and `spawn_agent` is optional and bounded; private spawn transcripts are never traversed. At most 200 sessions, 12 excerpts, and 1,200 characters per excerpt are scanned/returned. Text is untrusted, possibly stale, redacted best-effort, and retained in current session history; full paths and filenames are not returned.

`session_stats` returns no message text, arguments, results, paths, or telemetry context. It separates main and child usage/cost, reports combined totals and cache-read rate, and bounds completed-tool counts/errors/images.

## Live and indexed search

`rg` and `fd` can search any directory the Pi process can access, including outside the workspace, which can expose external names and contents to the model. `rg` falls back to `grep`; `fd` tries `fd`/`fdfind`, then POSIX `find`. Fallback behavior may include hidden/ignored paths and differs by local tool. Output is bounded; ripgrep skips files over 512 KiB and limits matches per file. `relationship_graph` is text heuristic, not semantic analysis; verify important results in source. It is deferred in the host but available to Repo Scout's child.

The code index is a machine-local SQLite database shared once per canonical physical Git repository and scoped back to each logical workspace. It indexes tracked, non-ignored supported source files on start and reconciles dirty paths after turns. Source files are never changed. Files over 512 KiB, binaries, symlinks, ignored files, and unsupported extensions are skipped. Refreshes, membership changes, and schema upgrades are transactional; SQLite uses WAL and bounded locking.

`symbol_search` is case-insensitive exact/prefix/substring matching with optional path, language, and kind filters. Extraction is heuristic. `code_search` is FTS5 lexical ranking, not semantic/embedding search, and defaults to ten one-line excerpts. Both refresh first and report bounded JSON/truncation counts. The database defaults to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-discover/index.sqlite
```
Pylon Web uses `~/.pylon/agent` as `<agent-dir>` by default. Standalone Pi uses its host agent directory, normally `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides the host that sets it.

Set `PI_DISCOVER_INDEX_PATH` to override it. `refresh` reconciles changes, `rebuild` fully indexes the current workspace, and `prune` removes records whose roots no longer exist.