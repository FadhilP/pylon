# Bundled trust stores

`global-bundle.pem` is the official Amazon RDS global certificate bundle, used only when a PostgreSQL connection explicitly selects the AWS RDS CA preset. Pylon keeps certificate-chain and hostname verification enabled.

- Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
- Retrieved: 2026-09-09
- SHA-256: `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`

Refresh this file from the authoritative URL when AWS updates the bundle, update the checksum above, and run the database setup and package bundle tests.
