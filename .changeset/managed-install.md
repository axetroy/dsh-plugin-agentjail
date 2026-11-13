---
'dsh-plugin-agentjail': minor
---

An opt-in managed download (`daemon.managedInstall`), off by default, that
fetches the platform release archive and verifies its published SHA-256 before
extracting anything. A missing manifest entry, a digest mismatch, or an oversized
body installs nothing. `AGENTJAIL_BIN` is read when `daemon.binary` is empty.
