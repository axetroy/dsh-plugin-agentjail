---
'dsh-plugin-agentjail': minor
---

A read-only security dashboard, served by the Harness web server when one is
composed. `/agentjail` renders HTML to a browser and fixed-width text to anything
else; `/agentjail/api/{summary,decisions,health}` serve JSON. It cannot widen a
policy, clear a denial, or change the failure posture. See `docs/UI.md`.
