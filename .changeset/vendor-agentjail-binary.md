---
'dsh-plugin-agentjail': minor
---

Vendored AgentJail binary. The published package now carries the AgentJail build
it was tested against, so installing the plugin is enough to get a working engine
with no second step. A build outside the supported window (`>=1.8.0 <2.0.0`) is
refused rather than started, which is what keeps an upstream release from changing
the engine under a plugin that was not tested against it. `daemon.binary` and
`AGENTJAIL_BIN` still win, so pinning your own build is unchanged.
