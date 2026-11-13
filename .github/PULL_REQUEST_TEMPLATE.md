## What changed

<!-- One or two sentences. What behavior is different after this change? -->

## Why

<!-- The problem this solves. Link the issue when there is one. -->

## Security impact

<!-- Required for this repository. Check every line that applies. -->

- [ ] This change does not touch the enforcement path (`tools/pre-execute`, `security/decision.ts`, `security/grants.ts`).
- [ ] This change touches the enforcement path, and I have explained below why it cannot turn a deny into an allow.
- [ ] This change cannot turn an unreachable engine, a timeout, a malformed frame, or an exception into an allow.
- [ ] No new path writes tool arguments to a sink without redaction.

Explanation for any box left unchecked above:

## How it was verified

<!-- Which tests cover this? Paste the command you ran. -->

```
npm run verify
```

## Checklist

- [ ] `npm run verify` passes locally.
- [ ] Tests cover the new behavior, including the failure path.
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` when the change is user-visible.
- [ ] Documentation is updated when configuration or behavior changed.
