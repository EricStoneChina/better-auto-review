# Contributing

Thanks for testing Better Auto Review.

## Development

Requirements: Node.js 22 or newer. There are no runtime dependencies.

```bash
npm test        # run the state-machine harness
npm run check   # syntax check
npm pack --dry-run
```

## Pull requests

- Keep the plugin dependency-free: it is a DSH bundle, not a general library.
- Add or update a test in `test/harness.mjs` for any behaviour change.
- Describe the DSH version and preset configuration you tested with.
- Do not commit credentials, profiles, or generated logs.

## Reporting bugs

Open an issue with:

1. DSH version, OS and Node version.
2. The permission preset and relevant `cordis.patch.yml` rows.
3. The `better-auto-review:` log lines around the failure.
4. Whether the call was expected to be an escalation (it must carry `sandbox_permissions`).

## Security

Better Auto Review decides whether one explicit sandbox escalation may run. It is not a sandbox and does not inspect tools that ignore DSH's sandbox protocol. Please report security-relevant issues privately to the maintainer rather than in a public issue when they could enable bypasses.
