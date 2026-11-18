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
2. the session's permission preset is the configured preset (`auto-review` by default);
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
    "@ericstonechina/better-auto-review": "^0.1.0"
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

Restart DSH (or use the plugin manager to enable the bundle). The bundle patch inserts the plugin row and adds the **Better Auto Review** permission preset.

### From GitHub (pre-release / development)

```bash
pnpm add github:EricStoneChina/better-auto-review
```

Use the same `dsh.profile.bundles` entry with the package name.

### Enable it

Open a session's permission selector and choose **Better Auto Review**. The preset uses `workspace-write` plus `approval: ask`; the plugin intercepts only escalation requests, so normal workspace work is unaffected.

Sessions still on the built-in `auto` preset are migrated to `auto-review` when their agent appears. The built-in plugin is intentionally kept installed so old sessions can still restore without errors.

## Configuration

Defaults live in the bundle's [cordis.patch.yml](cordis.patch.yml). Override them from your profile's `cordis.patch.yml` with the same row id:

```yaml
- id: better-auto-review
  config:
    provider: magpie-responses
    model: codex/gpt-6.2-sol
    reasoningEffort: medium
    maxTokens: 600
    preset: auto-review
    baselineSandbox: workspace-write
    maxConsecutiveDenials: 3
    onError: deny
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `magpie-responses` | LLM route used by the reviewer |
| `model` | `codex/gpt-6.2-sol` | Reviewer model |
| `reasoningEffort` | `medium` | Optional reasoning effort; empty uses the adapter default |
| `maxTokens` | `600` | Reviewer output cap |
| `preset` | `auto-review` | Permission preset this plugin is active on |
| `baselineSandbox` | `workspace-write` | Anything at or below this rank is not reviewed |
| `maxConsecutiveDenials` | `3` | Denials before a manual decision |
| `onError` | `deny` | `deny` (fail closed) or `ask` on reviewer failure |

The reviewer can be any route your DSH LLM configuration exposes. It does not have to be the model used by the main session.

## What the reviewer sees

- current working directory;
- baseline and requested sandbox modes;
- the last two genuine user messages (treated as trusted intent);
- the names and truncated arguments of the last eight tool calls;
- the full name and arguments of the pending call, including `justification`.

Tool names, arguments and any text inside them are treated as **untrusted data**; only user messages are treated as authorisation. The reviewer must answer with strict JSON:

```json
{"decision":"allow"}
```

```json
{"decision":"deny","reason":"why this escalation is not justified"}
```

Anything else is a reviewer failure and follows `onError`.

## Security model and limits

Better Auto Review is a *reviewer of escalations*, not a replacement for the sandbox. Its guarantee is:

> A tool call runs with a wider sandbox only if it explicitly requests `sandbox_permissions` wider than the baseline **and** the reviewer allows that one call.

Consequences:

- The `workspace-write` sandbox is still the primary enforcement boundary.
- A tool that ignores the DSH sandbox and does not use `sandbox_permissions` (for example, some third-party or MCP tools) is outside this plugin's control; rely on that tool's own permission model.
- The reviewer is a model: it can be wrong. Start with `workspace-write`, keep `onError: deny`, and use `maxConsecutiveDenials` to pull a human in early.

## Logs

All messages use the prefix `better-auto-review:` and report migrations, allowed escalations, denials and reviewer failures.

## Development

```bash
npm test        # node:test harness for the plugin state machine
npm run check   # syntax check
npm pack --dry-run
```

The test harness stubs the DSH host (permission presets, LLM stream, tool pipeline, approval listener), so it runs without a DSH installation.

## Feedback

This is an early public test release. Please open an [issue](https://github.com/EricStoneChina/better-auto-review/issues) with:

- your DSH version and OS;
- the preset and `cordis.patch.yml` configuration you used;
- the `better-auto-review:` log lines around the problem.

## License

MIT © 2026 EricStoneChina
