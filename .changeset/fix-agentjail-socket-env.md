---
'dsh-plugin-agentjail': patch
---

`AGENTJAIL_SOCKET` is now honored. The documentation described it, but
`resolveSocketPath` did not read it.
