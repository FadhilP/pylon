# pi-discover

General-purpose read-only repository and tool discovery for [Pi](https://pi.dev).

## Usage

`search_tools({ query, limit? })` keyword-ranks inactive eligible tools by name and description, then asks Pylon to activate up to six matches. The selected definitions become callable on the next model turn. `search_tools({ action: "reset" })` resets the coordinated selection.

Tool activation is intentionally delegated to Pylon through its discovery capability. Without that coordinator, `search_tools` reports that coordination is unavailable and changes no active tools.

`rg` and `fd` are read-only workspace searches. They use bounded output and direct models to built-in `grep` or `find` when their optional executables are unavailable. Their implementations, plus `relationship_graph`, live in separate `src` modules shared by the host extension and pi-discover's child entrypoint. The host advertises that entrypoint through a versioned capability so Repo Scout can load these tools only when pi-discover is present.

`relationship_graph({ query, path?, glob?, max_results? })` returns bounded JSON containing query, file, and source-location nodes joined by `contains` and `mentions` edges. Location roles such as `possible_definition` and `possible_call` are text heuristics, not semantic resolution; confirm important relationships from source. Identifier queries use whole-word matching. Other tokens use exact literal matching.
