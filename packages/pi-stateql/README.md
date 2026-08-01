# pi-stateql

Safe stateful database access for [Pi](https://pi.dev), backed by [`@fadhilp/stateql`](https://github.com/FadhilP/stateql).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

Run `/reload` after installation. In the Pylon bundle, the `stateql` tool is deferred until `search_tools` activates database access.

## Usage

### Capabilities

Use the `stateql` tool for StateQL connection profiles, read-only queries, materialized result handles, filtering, schema and storage-health inspection, write plans, confirmed writes, transactions, receipts, and bounded history. Each Pi session is an actor in one durable StateQL workspace; linked actors reuse its connection, handles, aliases, cache, and history. StateQL membership, lifecycle, purge, and export commands are intentionally unavailable to the model-facing tool.

### Connections and Credentials

Prefer profiles and credential environment variables. A `secret_env` value replaces `target` and must resolve to a complete PostgreSQL/MySQL URL or explicit `sqlite:<path>` source, not only a password or bare SQLite path; do not pass both fields. In Pylon Web, a PostgreSQL/MySQL `target` containing a username but no password opens a masked password-only dialog. Submitting it authorizes that connection, so there is no redundant connect confirmation. Pylon inserts and temporarily reuses the password for the same actor, workspace, endpoint, database, user, and access level while preserving connection options. PostgreSQL `sslmode=prefer`, `require`, and `verify-ca` use StateQL's strict verification unless `uselibpqcompat=true`; that opt-out requires a separate insecure-TLS confirmation.

### Examples

```text
{ "command": "connect", "profile": "local" }
{ "command": "connect", "secret_env": "APP_DATABASE_URL", "read_only": true }
{ "command": "query", "sql": "SELECT id, name FROM users WHERE status = ? ORDER BY id LIMIT 50", "params": ["active"] }
{ "command": "rows", "handle": "q_1", "offset": 0, "limit": 20 }
{ "command": "doctor" }
```

## Safety and Privacy

### Confirmations and Data Disclosure

StateQL safety checks remain authoritative. Connection changes, database writes, plan application, transaction commit/rollback, and profile removal require interactive confirmation; they fail closed when confirmation is unavailable. SQL, parameters, and database results may be sent to the selected model provider and retained in Pi session history.

### Pylon Web

Pylon Web exposes a local, bounded workspace status/history view. It contains actor attribution, connection metadata, transaction ownership, recent handles/operations, and up to 100 command-history entries, but no SQL, parameters, result rows, or credentials.

### Missing Credentials

When a referenced database environment variable is missing, Pylon Web can request its complete connection source through a masked, private prompt. Password-only values, bare SQLite paths, and sources for the wrong database driver are rejected without retention. For a passwordless server `target` with a username, it requests only the password and reconstructs the matching source in memory. TLS/network retries to that same endpoint reuse the password; authentication failures invalidate it, read-to-write escalation prompts again, and insecure TLS still requires explicit confirmation. The submitted value stays in server memory for up to one hour and is scoped to the current runtime generation, Pi actor, StateQL workspace, credential reference, database identity, and approved access. Reads reuse read or write approval; write escalation always prompts again. Cancellation, session replacement, shutdown, expiry, or an identity mismatch fail closed and clear the applicable transient state. The value is never placed in tool content/details, transcripts, UI request events, diagnostics, or StateQL persistence.

Regular Pi installations keep using `process.env`. If a referenced value is missing and no trusted Pylon credential host is available, the operation fails closed without prompting or fallback. Set `STQL_HOME` to override StateQL's platform data directory.
