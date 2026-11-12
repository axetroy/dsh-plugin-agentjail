# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, a minor bump may include a breaking change; such
changes are always called out under `### Changed` or `### Removed`.

## [Unreleased]

## [0.1.0] - 2026-11-12

The first release. It implements all four phases of the design white paper.

### Added

- **Phase 1 — basic interception.** A `tools/pre-execute` gate that evaluates
  every tool call against AgentJail before the tool body runs, maps the verdict
  onto the registry's allow/deny vocabulary, and fails closed when the engine is
  unreachable, times out, or answers with something unparseable.
- **Phase 2 — full policy support.** Tool-call normalization from Harness names
  to AgentJail's Claude Code vocabulary (file, shell, network, and MCP calls), a
  policy layer that applies per-agent, per-session, and per-tool overrides ahead
  of the engine, and a bounded verdict cache with explicit invalidation for
  policy reloads. Six reviewed Rego templates ship under `policy/`.
- **Phase 3 — human approval and execution isolation.** An `approval/request`
  answerer that turns an engine `ask` into a Harness approval prompt, one-time
  and session grants bound to a session, tool, and argument digest, grant expiry
  and revocation, engine health probes, and a `tools/post-execute` observer that
  records OS sandbox denial signatures.
- **Phase 4 — enterprise governance.** A sliding-window risk metrics collector,
  deny-rate alerting, a structured security report with a policy digest, and
  grant and audit query surfaces exposed on the `agentjail` service.
- **Audit trail.** One JSON Lines record per decision, with an in-memory ring
  buffer and size-based file rotation, queryable by session, tool, verdict, and
  time. Sensitive values are redacted before they reach any sink.
- **Bundle packaging.** A `dsh.bundle` manifest and a `cordis.patch.yml` layer,
  so the plugin installs with `dsh plugin add` and is configured by row id.
- **Documentation.** `README.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`,
  `docs/POLICY.md`, `docs/OPERATIONS.md`, `docs/THREAT-MODEL.md`, and
  `SECURITY.md`, plus runnable examples under `examples/`.

### Security

- Deny-by-default posture: `failureAction`, `defaultAction`, and the Rego
  templates all resolve to deny, and the failure action refuses to be set to
  `allow` in the shipped bundle patch.
- A monotonic guard re-asserts a resolved denial, so a later `tools/pre-execute`
  listener cannot re-open a call the gate blocked.
- The gate never throws. A thrown listener would surface to the model as an
  ordinary tool failure, which is indistinguishable from a policy denial and
  therefore useless as a security signal.

[Unreleased]: https://github.com/axetroy/dsh-plugin-agentjail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/axetroy/dsh-plugin-agentjail/releases/tag/v0.1.0
