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

In Pylon Web, enter passwords directly in the connection form. The form answers only its matching, owned password request through the secure response channel; it never adds a password to StateQL input. Passwordless remote targets (including saved target profiles) use the same broker; agent-initiated requests can still open a masked password dialog. A missing `secret_env` can open a masked complete-source dialog; invalid source types are rejected. Required approvals replace the form rather than appearing inside it. Credential prompts follow the configured Guard timeout; `Never` disables UI expiry, while StateQL retains a bounded 24-hour-plus-one-minute safety deadline. Submitted credentials stay in server memory for up to one hour, scoped to runtime generation, actor, workspace, reference, database identity, and approved access; explicit Remember consent can additionally store them in the OS credential vault. Authentication failure, cancellation, session replacement, shutdown, expiry, identity mismatch, or read-to-write escalation clears/requires the credential and fails closed as appropriate. Credentials never appear in tool content/details, transcripts, UI request events, diagnostics, or StateQL persistence. In ordinary Pi, a missing environment variable fails closed; it never prompts or falls back.

TLS/network retry can reuse approved credentials for the same endpoint. `sslmode=prefer`, `require`, and `verify-ca` use strict StateQL verification unless `uselibpqcompat=true`; that opt-out requires separate insecure-TLS confirmation.

For AWS RDS, the Web form can explicitly select Pylon's packaged official **AWS RDS global trust bundle**. The preset remains connection-scoped and keeps certificate and hostname verification enabled. Other PostgreSQL servers can use the server runtime's default trust store or a **Custom CA file**; custom paths map to `sslrootcert` and must be readable by the server process.

### Unified Web setup and compatibility

The Web form submits one `connection.setup` operation. Its reviewed configuration is authoritative: passwords from compatible legacy profiles/vault entries cannot replace submitted host, database, TLS, or CA settings. **Save & connect** connects first and saves afterward; partial save failures remain connected and can retry saving without reconnecting. **Save only** does not test the connection, and sends no form password unless remembering it is selected.

New remembered literal-target profiles persist a password-free `target` plus `password_ref`; the OS vault stores a destination-bound password-only v2 record. Existing environment and complete-URL vault profiles remain readable. Explicit replacement edits use only a matching legacy password, not the legacy URL's configuration. Valid same-destination retries reuse the existing bounded password broker; newly entered passwords supersede cached values.

This setup requires the updated StateQL runtime exposing `StateQL.passwordReferenceVersion === 1`; older runtimes fail closed rather than silently ignoring `password_ref`. The current development checkout uses the rebuilt sibling `../StateQL` package. Publish and pin a compatible StateQL release before distributing this change; reinstalling the currently pinned registry version is not sufficient. Stop Pylon and back up the complete StateQL data directory before upgrading. The password-reference schema migration is not downgrade-safe: do not open state homes containing password references with older StateQL binaries.

## Pylon Web workspace view

Pylon Web provides a local bounded state/history view with actor attribution, connection metadata, transaction ownership, recent handles/operations, and up to 100 history entries. It excludes parameters and credentials. Materialized rows are absent from the snapshot and load only in bounded pages when explicitly expanded.

Treat all returned resource IDs as opaque strings: pass them back unchanged, accept both legacy numeric suffixes and random suffixes, and do not derive ordering from IDs. Random canonical IDs do not replace or rewrite existing records or references. Display aliases remain valid alternate handles. State-version tokens such as `sv_*` remain counters for cache and write-safety semantics, not resource IDs.
