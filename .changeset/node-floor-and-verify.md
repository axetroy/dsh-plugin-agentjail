---
'dsh-plugin-agentjail': minor
---

The Node floor is `>=22.18.0`, raised from `>=20.10.0`. The `prepare` script runs
`tsdown` on install, and its rolldown plugin requires Node `^22.18.0`, so the
previous floor described a version the package could not install on. CI now tests
Node 22 and 24. `npm run verify` runs `format:check` first, so the local command
and CI run the same sequence. `package.json` gained a `publishConfig` block
recording `access: public` and `provenance: true`, so a manual publish matches
what CI produces.
