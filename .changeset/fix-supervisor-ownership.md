---
'dsh-plugin-agentjail': patch
---

Fixed a daemon supervision bug where a second `ensureDaemon` pass disowned a
daemon the plugin had started. The daemon kept running, but the plugin reported it
as external, so it stopped being stopped on unload and reload stopped being
attempted against it.
