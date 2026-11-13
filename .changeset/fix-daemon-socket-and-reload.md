---
'dsh-plugin-agentjail': patch
---

Daemon starts now pass `--socket`, `--db`, and `--log` explicitly and run under a
private `HOME`. Upstream's daemon does not read `AGENTJAIL_SOCKET`, so without the
flag it bound its own default socket and the plugin never reached the daemon it
started. The private `HOME` keeps a start from reaching a stale control plane left
behind by an unrelated AgentJail install.

Policy reload now goes through the daemon's privileged control socket and only for
a daemon this plugin started. Reloading an adopted daemon - or the wrong one, via
whatever control plane sits under the process `HOME` - is refused, and the plugin
reports why instead of guessing.
