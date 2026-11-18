# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project aims to follow Semantic Versioning.

## [0.1.2] - 2026-11-18

### Added

- P0 safety and cost controls for the reviewer: `reviewerProvider`, `reviewerModel`, `reviewerReasoningEffort` (default `low`), `reviewerTimeoutMs`, `maxReviewsPerTurn`, `maxFailuresPerTurn`, a sliding denial circuit (`denialWindowSize` / `maxWindowDenials`), and a short-lived fingerprint verdict cache (`verdictCacheTtlMs` / `verdictCacheMaxEntries`). These prevent a repeated Windows sandbox failure from consuming unlimited reviewer quota.
- Structured reviewer verdicts: `{decision, reason, riskLevel}`. `high` is always denied, `medium` requires a specific authorising user request, and `low` is allowed.
- Deterministic hard-deny rules for disk/filesystem destruction, recursive deletion of a drive root or home directory, secret exfiltration to a network destination, and credential dumping/security-control tampering.
- Tests for hard denials, medium-risk authorization, dedicated reviewer route, verdict cache, per-turn review budget, and reviewer timeout.

### Changed

- Default reviewer output cap is `800` tokens and the default reviewer reasoning effort is `low`, independent of the main coding model.

## [0.1.1] - 2026-11-18

### Changed

- The reviewer-backed preset key is now `auto-mode` (formerly `auto-review`) and is the default for new sessions (`defaultPreset: auto-mode` in `cordis.patch.yml`), so Better Auto Review takes effect without a manual permission-selection step. The key is chosen so the Claude-style skin's fixed four-segment control (`Read | Edit | Auto | Yolo`) maps its **Auto** button to this preset ahead of the built-in `auto`; users see no fifth button and need no skin changes. The built-in `auto` preset stays available and installed so existing Auto sessions keep restoring; sessions on `auto` or the earlier `auto-review` key are migrated to `auto-mode`.
- The reviewer policy now defaults to allowing routine local development, diagnostics, and reversible environment or file-permission repairs, and requires a concrete reason to deny. It also sees up to six recent user messages, so a broad "continue" or complaint retains enough intent for repair work.

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
