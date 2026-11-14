---
'dsh-plugin-agentjail': minor
---

A read-only security panel in the Harness Settings dialog. The plugin ships a
browser half that registers one `settings.section` through the client slot
system, so the audit trail, risk statistics, engine health, and outstanding
approvals appear next to General and Plugins instead of on a page the plugin
serves itself. The section is contributed by the client and removed by the
disposer when the plugin unloads.

The Host registers only the data routes the panel reads, when a Harness web
server is composed: `/agentjail/api/{summary,decisions,health}` as JSON, and
`/agentjail` as fixed-width text for `curl`. Nothing can widen a policy, clear a
denial, or change the failure posture. See `docs/UI.md`.
