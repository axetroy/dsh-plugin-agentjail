---
'dsh-plugin-agentjail': minor
---

`ctx.agentjail.grantSession` issues a session-scoped grant so a workflow that
legitimately repeats one command is not prompted each time, and
`ctx.agentjail.reloadPolicy` asks the daemon to reload its policy and drops the
verdict cache with it.
