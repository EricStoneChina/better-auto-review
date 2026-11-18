# Better Auto Review

**Codex-style auto review for [DeepSeek Harness](https://github.com/deepseek-ai). Keep the sandbox, review only the escalations.**

[中文说明](README.zh-CN.md) · [Issues](https://github.com/EricStoneChina/better-auto-review/issues) · [MIT License](LICENSE)

---

DeepSeek Harness ships an Auto Review preset that asks a reviewer model about *every* tool call and, when it approves, runs the rest of the session with `danger-full-access`. That is safe only if you trust the reviewer completely, and it makes even a `read` inside the workspace pay a model round-trip.

Better Auto Review takes the Codex approach:

- the session stays inside the **`workspace-write` sandbox**;
- the reviewer is consulted **only when one tool call explicitly asks to escalate** its sandbox through `sandbox_permissions`;
- an approval covers **exactly that one call** (`allowed-once`), never the whole session;
- a denial explains why, and repeated denials fall back to a human.

## Why

| | Built-in Auto Review | Better Auto Review |
| --- | --- | --- |
| Review scope | every tool call | only explicit sandbox escalations |
| Baseline sandbox | `danger-full-access` | `workspace-write` |
| Approval lifetime | whole session | one call (`allowed-once`) |
| Workspace `read`/`write` | one reviewer call each | **zero reviewer calls** |
| Denial message | generic | reviewer's reason included |
| Reviewer model | fixed to the session model | configurable, independent route |
| Reviewer error | implementation-defined | **fail closed** by default |

## How "escalation" is detected

The plugin listens on `tools/pre-execute` and only proceeds when all of these hold:

1. the call belongs to an agent (nested `run_code` calls included; the outer `run_code` wrapper is skipped);
2. the session's permission preset is the configured preset (`auto-mode` by default);
3. the tool arguments contain a string `sandbox_permissions`;
4. `rank(sandbox_permissions) > rank(baselineSandbox)`, where the rank is
   `read-only = 0`, `workspace-write = 1`, `danger-full-access = 2`.

With the default `baselineSandbox: workspace-write`, only `danger-full-access` triggers a review. Everything inside the workspace runs with no reviewer call at all.

On **allow**, the plugin remembers the call id and answers the tool's one-shot escalation approval with `allowed-once`. On **deny**, the call is rejected before its body runs. After `maxConsecutiveDenials` denials the next one is handed to the human. Reviewer errors are denied by default (`onError: deny`) or handed to the human (`onError: ask`).

## Install

### From npm (recommended)

```bash
# in your DSH profile directory, e.g. ~/.dsh/profiles/desktop
pnpm add @ericstonechina/better-auto-review
```

Then add the bundle to the profile's `package.json`:

```json
{
  "dependencies": {
    "@ericstonechina/better-auto-review": "^0.1.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@ericstonechina/better-auto-review"
      ]
    }
  }
}
```

Restart DSH (or use the plugin manager to enable the bundle). The bundle patch inserts the plugin row, adds the **Better Auto Review** permission preset, and makes it the default for new sessions.

### From GitHub (pre-release / development)

```bash
pnpm add github:EricStoneChina/better-auto-review
```

Use the same `dsh.profile.bundles` entry with the package name.

### Enable it

The bundle makes **Better Auto Review** the default preset for new sessions (via `defaultPreset: auto-mode` in the bundle's `cordis.patch.yml`), so you never have to pick it by hand. New sessions start on it with `workspace-write` plus `approval: ask`, and the plugin intercepts only escalation requests, so normal workspace work is unaffected. You can still switch any session to another preset from the permission selector; the default only applies to sessions created afterwards. The preset key is `auto-mode` deliberately: the Claude-style skin's fixed four-button control maps its **Auto** button to `auto-mode` before `auto`, so Auto runs this reviewer instead of the built-in every-call reviewer, with no fifth button and no source edits.

Sessions still on the built-in `auto` preset (or the earlier `auto-review` key) are migrated to `auto-mode` when their agent appears. The built-in plugin is intentionally kept installed so old sessions can still restore without errors.

## Configuration

Defaults live in the bundle's [cordis.patch.yml](cordis.patch.yml). Override them from your profile's `cordis.patch.yml` with the same row id:

```yaml
- id: better-auto-review
  config:
    provider: magpie-responses
    model: codex/gpt-6.2-sol
    reviewerProvider: magpie-responses
    reviewerModel: codex/gpt-6.2-sol
    reviewerReasoningEffort: low
    reviewerTimeoutMs: 60000
    maxTokens: 800
    reviewerSubagent: true
    reviewerSubagentProvider: spawn
    reviewerPreset: better-auto-review-readonly
    reviewerTools:
      - read
      - glob
      - grep
    reviewerFallback: llm
    preset: auto-mode
    baselineSandbox: workspace-write
    maxConsecutiveDenials: 3
    denialWindowSize: 10
    maxWindowDenials: 6
    maxReviewsPerTurn: 10
    maxFailuresPerTurn: 10
    verdictCacheTtlMs: 60000
    verdictCacheMaxEntries: 128
    onError: deny
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` / `model` | `magpie-responses` / `codex/gpt-6.2-sol` | Backward-compatible route used when no reviewer route is set |
| `reviewerProvider` | value of `provider` | LLM route dedicated to review calls |
| `reviewerModel` | value of `model` | Reviewer model; keep it separate from the main coding model if possible |
| `reviewerReasoningEffort` | `low` | Reasoning effort for the reviewer; low keeps reviews fast and cheap |
| `reviewerTimeoutMs` | `60000` | Hard timeout for one review; timeout fails closed |
| `maxTokens` | `800` | Reviewer output cap |
| `reviewerSubagent` | `true` | Run each review as a read-only child agent that can inspect the workspace |
| `reviewerSubagentProvider` | `spawn` | DSH subagent provider used for the reviewer (`spawn` starts with no parent history) |
| `reviewerPreset` | `better-auto-review-readonly` | Agent preset for the reviewer; only `read`, `glob` and `grep` |
| `reviewerTools` | `read`, `glob`, `grep` | Tool whitelist enforced for the reviewer child; `structured_output` is always allowed |
| `reviewerFallback` | `llm` | `llm` falls back to the inline reviewer if the child cannot start; `deny` fails closed instead |
| `preset` | `auto-mode` | Permission preset this plugin is active on |
| `baselineSandbox` | `workspace-write` | Anything at or below this rank is not reviewed |
| `maxConsecutiveDenials` | `3` | Consecutive denials before a manual decision |
| `denialWindowSize` | `10` | Sliding window used by the denial circuit |
| `maxWindowDenials` | `6` | Denials in the window before a manual decision |
| `maxReviewsPerTurn` | `10` | Review calls allowed in one turn before falling back to the human |
| `maxFailuresPerTurn` | `10` | Reviewer failures allowed in one turn before falling back to the human |
| `verdictCacheTtlMs` | `60000` | Short cache for identical escalation fingerprints; `0` disables it |
| `verdictCacheMaxEntries` | `128` | Cache size cap |
| `onError` | `deny` | `deny` (fail closed) or `ask` on reviewer failure |

The reviewer can be any route your DSH LLM configuration exposes. It does not have to be the model used by the main session.

## What the reviewer sees

By default the reviewer is a fresh `spawn` child agent on the read-only `better-auto-review-readonly` preset. It receives only the bounded summary below plus its own `read`/`glob`/`grep` tool results; a `agent/pre-step` firewall drops injected system, plugin and runtime-context messages, so project instructions cannot steer the verdict.

- current working directory;
- baseline and requested sandbox modes;
- the last six genuine user messages (treated as trusted intent);
- the names and truncated arguments of the last eight tool calls;
- the full name and arguments of the pending call, including `justification`.

The reviewer is instructed to allow routine development work and local diagnostics or repairs (including fixing workspace file permissions) and to deny only clear high-risk actions. A broad "continue", "fix it", or complaint that something keeps failing is enough intent for reversible local repair, and every denial must give a concrete reason.

Tool names, arguments and any text inside them are treated as **untrusted data**; only user messages are treated as authorisation. The child cannot call `write`, `edit`, `apply_patch`, `pwsh`/shell or `run_code`; `tools/pre-execute` denies those with `AUTO_REVIEW_READ_ONLY` even if the preset were misconfigured. The reviewer must submit strict JSON through the `structured_output` tool:

```json
{"decision":"allow","reason":"short reason","riskLevel":"low"}
```

```json
{"decision":"deny","reason":"why this escalation is not justified","riskLevel":"high"}
```

The plugin also applies deterministic rules before asking the model: disk/filesystem destruction, recursive deletion of a drive root or home directory, secret exfiltration to a network destination, and credential dumping/security tampering are hard-denied even if the reviewer would allow them. A `high` risk verdict is always denied; a `medium` verdict needs a specific authorising user request; a `low` verdict is allowed. Anything else is a reviewer failure and follows `onError`.

## Security model and limits

Better Auto Review is a *reviewer of escalations*, not a replacement for the sandbox. Its guarantee is:

> A tool call runs with a wider sandbox only if it explicitly requests `sandbox_permissions` wider than the baseline **and** the reviewer allows that one call.

Consequences:

- The `workspace-write` sandbox is still the primary enforcement boundary.
- A tool that ignores the DSH sandbox and does not use `sandbox_permissions` (for example, some third-party or MCP tools) is outside this plugin's control; rely on that tool's own permission model.
- The reviewer is a model: it can be wrong. Start with `workspace-write`, keep `onError: deny`, and use `maxConsecutiveDenials` to pull a human in early.
- The read-only child is a defense-in-depth layer for the reviewer, not a new sandbox for the main agent. If the child cannot start, `reviewerFallback: llm` keeps the inline reviewer path; use `deny` to fail closed instead.
- A repeated Windows sandbox failure cannot spin the reviewer forever: identical requests hit a short-lived verdict cache, and review/failure budgets plus a sliding denial circuit fall back to a human instead of consuming unlimited quota.

## Logs

All messages use the prefix `better-auto-review:` and report migrations, allowed escalations, denials and reviewer failures.

## Development

```bash
npm test        # node:test harness for the plugin state machine
npm run check   # syntax check
npm pack --dry-run
```

The test harness stubs the DSH host (permission presets, LLM stream, subagent service, tool pipeline, approval listener), so it runs without a DSH installation.

## Feedback

This is an early public test release. Please open an [issue](https://github.com/EricStoneChina/better-auto-review/issues) with:

- your DSH version and OS;
- the preset and `cordis.patch.yml` configuration you used;
- the `better-auto-review:` log lines around the problem.

## License

MIT © 2026 EricStoneChina
