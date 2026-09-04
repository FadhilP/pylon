# pi-stateql

Safe stateful database access for Pi, backed by [@fadhilp/stateql](https://github.com/FadhilP/stateql).

## Install and availability

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. In the Pylon bundle, the single `stateql` tool is deferred until `search_tools` activates database access.

## Use the `stateql` tool

StateQL manages connection profiles, read queries, materialized result handles, filters, schema/storage health, write plans and confirmed writes, transactions, receipts, and bounded history. Each Pi session is an actor in one durable StateQL workspace; linked actors share its connections, handles, aliases, cache, and history. Membership, lifecycle, purge, and export controls are intentionally not model-facing.

```text
{ "command": "connect", "profile": "local" }
{ "command": "connect", "secret_env": "APP_DATABASE_URL", "read_only": true }
{ "command": "query", "sql": "SELECT id, name FROM users WHERE status = ? ORDER BY id LIMIT 50", "params": ["active"] }
{ "command": "rows", "handle": "q_1", "offset": 0, "limit": 20 }
{ "command": "doctor" }
```

Prefer profiles and credential environment variables. `secret_env` replaces `target`; it must resolve to a complete PostgreSQL/MySQL URL or `sqlite:<path>`, not a password or bare SQLite path. Do not provide both. Set `STQL_HOME` to override StateQL's platform data directory.

## Confirmations and credentials

StateQL checks remain authoritative. Connection changes, writes, plan application, transaction commit/rollback, and profile removal require interactive confirmation and fail closed without it. SQL, parameters, and returned database rows may enter Pi history and be sent to the selected model provider.

In Pylon Web, a passwordless PostgreSQL/MySQL target with a username opens a masked password-only dialog. A missing `secret_env` can open a masked complete-source dialog; invalid source types are rejected. Credential prompts follow the configured Guard timeout; `Never` disables UI expiry, while StateQL retains a bounded 24-hour-plus-one-minute safety deadline. Submitted credentials remain only in server memory for up to one hour, scoped to runtime generation, actor, workspace, reference, database identity, and approved access. Authentication failure, cancellation, session replacement, shutdown, expiry, identity mismatch, or read-to-write escalation clears/requires the credential and fails closed as appropriate. Credentials never appear in tool content/details, transcripts, UI request events, diagnostics, or StateQL persistence. In ordinary Pi, a missing environment variable fails closed; it never prompts or falls back.

TLS/network retry can reuse approved credentials for the same endpoint. `sslmode=prefer`, `require`, and `verify-ca` use strict StateQL verification unless `uselibpqcompat=true`; that opt-out requires separate insecure-TLS confirmation.

## Pylon Web workspace view

Pylon Web provides a local bounded state/history view with actor attribution, connection metadata, transaction ownership, recent handles/operations, and up to 100 history entries. It excludes parameters and credentials. Materialized rows are absent from the snapshot and load only in bounded pages when explicitly expanded.