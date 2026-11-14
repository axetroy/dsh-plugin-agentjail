---
'dsh-plugin-agentjail': patch
---

Make the supported platform set explicit instead of implied. The plugin runs
AgentJail from a build vendored per platform, and upstream publishes no Windows
build, so `package.json` now declares `os: [linux, darwin]` and
`cpu: [x64, arm64]` and npm refuses an unsupported platform at install time
rather than letting it fail silently at runtime. Loading on a platform with no
vendored build logs a warning naming the platform and the reason, so an operator
sees why every protected call is denied instead of inferring it from the denials.
CI now runs the suite and the real vendored binary on macOS, which was previously
a claimed platform that nothing ever exercised. That job immediately caught two
portability bugs the Linux-only suite could not see: archive extraction passed
`--wildcards` to `tar`, which GNU tar accepts and BSD tar rejects, so a managed
install failed on macOS; and a policy reload that fell back to restarting the
daemon probed once the instant the child was spawned instead of polling, so a
daemon that was merely still binding its socket was reported as unreachable.
Both are fixed and covered by tests. See `docs/INSTALL.md`.
