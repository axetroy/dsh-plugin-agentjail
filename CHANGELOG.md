# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, a minor bump may include a breaking change; such
changes are always called out under `### Changed` or `### Removed`.

## [Unreleased]

### Added

- A Simplified Chinese README (`README.zh-CN.md`), with language links in both
  directions. A test asserts the two stay structurally in sync, so a translated
  section cannot silently fall behind the English one.
- A read-only security dashboard, served by the Harness web server when one is
  composed. `/agentjail` renders HTML to a browser and fixed-width text to
  anything else; `/agentjail/api/{summary,decisions,health}` serve JSON. It
  cannot widen a policy, clear a denial, or change the failure posture. See
  `docs/UI.md`.
- Daemon supervision. When no daemon answers, the plugin starts one from the
  first usable `agentjail` binary and stops it on unload. A daemon it did not
  start is adopted and never signalled, so an operator-managed daemon keeps its
  lifecycle. See `docs/INSTALL.md`.
- An opt-in managed download (`daemon.managedInstall`), off by default, that
  fetches the platform release archive and verifies its published SHA-256 before
  extracting anything. A missing manifest entry, a digest mismatch, or an
  oversized body installs nothing.
- `AGENTJAIL_BIN`, read when `daemon.binary` is empty.
- Release publishing now uses **npm trusted publishing** (OIDC) instead of a
  long-lived `NPM_TOKEN`. The workflow requests `id-token: write`, asserts the
  npm CLI is `>= 11.5.1` before publishing, and passes no `--provenance` flag
  because trusted publishing generates provenance automatically. See
  `CONTRIBUTING.md` for the one-time npm-side configuration.

### Changed

- The Node floor is `>=22.18.0`, raised from `>=20.10.0`. The `prepare` script
  runs `tsdown` on install, and its rolldown plugin requires Node `^22.18.0`, so
  the previous floor described a version the package could not install on. CI
  now tests Node 22 and 24.
- `npm run verify` runs `format:check` first, so the local command and CI run the
  same sequence.
- `package.json` gained a `publishConfig` block recording `access: public` and
  `provenance: true`, so a manual publish matches what CI produces.

### Fixed

- A release tag read from a redirect target was interpolated into a file name and
  a URL path without validation. A crafted tag such as `../../etc/passwd` could
  steer the archive write outside the install directory. `isSafeReleaseTag` now
  restricts a tag to a release-tag shape, and the archive write asserts
  containment under the working directory. This addresses CodeQL
  `js/http-to-file-access`.

- The generated Rego templates were rejected by OPA: they used v0 syntax, mixed
  statements into object literals, declared `deny_rules` in one shared package
  across every template, and called a nonexistent `regex.find_all_stringify`.
  They now render as valid Rego v1, one package per template, unioned by a
  generated entrypoint, and are evaluated against a real OPA binary in CI.
- `AGENTJAIL_SOCKET` is now honored. The documentation described it, but
  `resolveSocketPath` did not read it.

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
- **Documentation.** `README.md`, `README.zh-CN.md`,
  `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/POLICY.md`,
  `docs/OPERATIONS.md`, `docs/THREAT-MODEL.md`, `SECURITY.md`, and
  `CONTRIBUTING.md`, plus runnable examples under `examples/`.

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
