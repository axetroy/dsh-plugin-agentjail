---
'dsh-plugin-agentjail': minor
---

Daemon supervision. When no daemon answers, the plugin starts one from the first
usable `agentjail` binary and stops it on unload. A daemon it did not start is
adopted and never signalled, so an operator-managed daemon keeps its lifecycle.
See `docs/INSTALL.md`.
