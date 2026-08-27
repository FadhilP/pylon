# Agent Guidelines

## Testing

Tests must protect meaningful runtime behavior and regressions. Do not add tests that:

- merely confirm a feature, export, tool, command, or extension exists or registers;
- are satisfied by TypeScript typechecking or compilation;
- test static contracts, schemas, manifests, labels, descriptions, or metadata instead of behavior;
- assert UI/UX presentation details such as formatting, icons, labels, grouping, rendering, or display-only state;
- prove only that a `/command` or similar integration is registered.

Prefer a small number of tests covering observable behavior, state transitions, failure paths, validation, security, persistence, concurrency, lifecycle cleanup, and regressions that previously occurred. A registration assertion is acceptable only when incidental to exercising meaningful behavior.
