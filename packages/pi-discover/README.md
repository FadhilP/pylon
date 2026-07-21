# pi-discover

General-purpose read-only repository and tool discovery for [Pi](https://pi.dev).

## Usage

`search_tools({ query, limit? })` deterministically ranks inactive eligible tools. Exact normalized tool names and optional `aliases` or `capabilities` metadata rank above name fragments and description overlap. Query normalization lowercases, deduplicates, and sorts alphanumeric terms, so equivalent term order and punctuation produce the same ranking. Pylon selects up to six matches; unblocked selected definitions become callable on the next model turn.

Ranked results are cached for the current model turn using the normalized query, limit, and complete active/eligible tool inventory. A repeated miss returns an `alreadySearched` marker with opaque query and inventory identities instead of rerunning discovery. Turn completion, session start, inventory changes, and successful `search_tools({ action: "reset" })` invalidate applicable state.

Tool activation is intentionally delegated to Pylon through its discovery capability. Without that coordinator, `search_tools` reports that coordination is unavailable and changes no active tools. Aggregate search, cache, miss, offered, selected, blocked, and later-invoked counts appear in Pylon health diagnostics; raw queries are never included in those metrics.

`rg` and `fd` are read-only workspace searches. They use bounded output and direct models to built-in `grep` or `find` when their optional executables are unavailable. Their implementations, plus `relationship_graph`, live in separate `src` modules shared by the host extension and pi-discover's child entrypoint. The host advertises that entrypoint through a versioned capability so Repo Scout can load these tools only when pi-discover is present.

`relationship_graph({ query, path?, glob?, max_results? })` returns bounded JSON containing query, file, and source-location nodes joined by `contains` and `mentions` edges. Location roles such as `possible_definition` and `possible_call` are text heuristics, not semantic resolution; confirm important relationships from source. Identifier queries use whole-word matching. Other tokens use exact literal matching.
