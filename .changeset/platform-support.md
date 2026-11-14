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
a claimed platform that nothing ever exercised. See `docs/INSTALL.md`.
