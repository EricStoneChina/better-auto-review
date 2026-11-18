# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project aims to follow Semantic Versioning.

## [0.1.0] - 2026-11-18

### Added

- Initial public test release.
- Codex-style review: keeps the `workspace-write` sandbox and only reviews explicit `sandbox_permissions` escalations.
- `allowed-once` approval scoped to the reviewed call.
- Configurable reviewer provider/model/reasoning effort, independent of the main session model.
- `maxConsecutiveDenials` fallback to a human decision.
- Fail-closed handling of reviewer failures (`onError: deny`, optional `ask`).
- Automatic migration of built-in `auto` preset sessions to `auto-review`.
- `node:test` harness covering allow, deny, skip, fail-closed, denial fallback and migration paths.
