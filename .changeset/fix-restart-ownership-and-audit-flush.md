---
'dsh-plugin-agentjail': patch
---

Fixed two lifecycle defects found while auditing unload behavior. `restart()`
left the supervisor reporting a managed daemon as `exited` after starting its
replacement, so the plugin disowned a daemon it was running and refused the next
policy reload as if the daemon belonged to someone else. The unload path now
drains queued audit appends before the plugin fiber is torn down, so an unload
followed immediately by process exit no longer drops the last records.
