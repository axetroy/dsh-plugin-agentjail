---
'dsh-plugin-agentjail': minor
---

Release publishing uses **npm trusted publishing** (OIDC) instead of a long-lived
`NPM_TOKEN`. The workflow requests `id-token: write`, asserts the npm CLI is
`>= 11.5.1` before publishing, and passes no `--provenance` flag because trusted
publishing generates provenance automatically. See `CONTRIBUTING.md` for the
one-time npm-side configuration.
