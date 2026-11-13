# AGENTS.md

Repository-specific knowledge for agents working on `dsh-plugin-agentjail`.

## What this project is

A DeepSeek Harness (DSH) security plugin that routes every agent tool call
through [AgentJail](https://github.com/LuD1161/agentjail) — an OPA/Rego policy
daemon — before the tool body runs. The design white paper is `DESIGN.md`
(Chinese, v0.1); the practical documentation is `README.md` and `docs/`.

## Commands

```sh
npm ci
npm run verify          # format:check + lint + typecheck + test + build
npm run build           # tsdown → lib/  (.js + .d.ts, ESM)
npm run test            # vitest, unit + integration
npm run test:coverage
npm run lint:fix
npm run format
```

`npm run verify` mirrors CI. Run it before claiming a change works.

## Non-negotiable invariants

These are the reason the code is shaped the way it is. A change that breaks one is
a security regression, not a style disagreement.

1. **Nothing turns an unknown into an allow.** `security/decision.ts` resolves in
   a fixed order (exempt → override → grant → engine → default → failure). A
   transport failure can only reach the last step, which applies `failureAction`
   (default `deny`). Never reorder this.
2. **The gate never throws.** A thrown `tools/pre-execute` listener surfaces to
   the model as a generic tool failure, indistinguishable from a policy denial.
   Every failure path resolves a verdict instead.
3. **Denials are re-asserted.** `ctx.tools.guard` re-checks a resolved denial so a
   later listener cannot re-open a blocked call. Monitor mode must not arm it.
4. **Grants are narrow.** A grant binds session + tool + argument digest and is
   consumed on use.
5. **Redact before any sink.** `security/sanitizer.ts` runs before audit writes.
6. **One engine.** The plugin never evaluates policy; it normalizes, sends, and
   enforces. Rego lives in `security/policy.ts` templates.

## Layout

| Path                            | Role                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| `src/index.ts`                  | `apply()`, listener registration, `ctx.provide('agentjail', …)`         |
| `src/hooks/`                    | `tools/pre-execute` gate, post-execute observer, approval answerer      |
| `src/security/`                 | decision resolution, normalization, grants, policy templates, redaction |
| `src/adapter/`                  | socket connection, protocol frames, caching client                      |
| `src/adapter/version.ts`        | parse `agentjail version` output and gate on the supported window       |
| `src/adapter/runtime.ts`        | resolve the package root, state root, and vendored binary path          |
| `src/adapter/control.ts`        | daemon control-plane socket: token read and policy reload               |
| `src/adapter/supervisor.ts`     | locate and start a daemon; never adopts or stops a foreign one          |
| `src/adapter/installer.ts`      | opt-in managed download with SHA-256 verification                       |
| `src/ui/`                       | read-only dashboard rendering and its HTTP routes                       |
| `src/audit/`, `src/governance/` | audit trail, metrics, reports                                           |
| `src/config/schema.ts`          | Schemastery config; `Config` interface + schema export                  |
| `policy/`                       | Generated Rego bundle (see below)                                       |
| `vendor.lock.json`              | pinned AgentJail version, per-platform assets, and SHA-256 digests      |
| `scripts/vendor-agentjail.mjs`  | download and checksum-verify the pinned build into `vendor/`            |
| `scripts/`                      | CI helper checks (`check-exports.mjs`, `check-bundle.mjs`)              |

## Policy templates are generated

`policy/` is generated from `src/security/policy.ts` and a test fails if the two
drift. After editing a template:

```sh
npm run build
node -e "
  const { resolveTemplates, writeTemplateBundle, POLICY_TEMPLATES } = await import('./lib/security/policy.js')
  await writeTemplateBundle('policy', resolveTemplates(POLICY_TEMPLATES.map((t) => t.name)))
"
```

Each template renders into its own Rego package
(`agentjail.dsh.templates.<name>`); a generated entrypoint (`99-decision.rego`)
imports and unions them into `data.agentjail.dsh.decision`. Two templates
declaring `deny_rules` in one package would be an OPA redeclaration error — the
entrypoint exists to prevent that. Resolution order is deny > ask > allow.

### Validating Rego

Tests in `tests/unit/policy.test.ts` evaluate the generated Rego against a **real
OPA binary** when one is on `PATH` or `OPA_BIN` is set, and skip with a marker
otherwise. CI installs OPA and runs them. Do not merge a policy change you have
not evaluated.

```sh
opa check policy/
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' \
  | opa eval -d policy -I 'data.agentjail.dsh.decision'
```

## Testing conventions

- Integration tests (`tests/integration/plugin.test.ts`) mount the plugin on a
  real Cordis runtime with the real `ToolsService` and native executor, and
  assert that a denied call's body never ran. Extend these for enforcement
  changes.
- Adapter tests use a real Unix socket served by `tests/helpers/fake-daemon.ts`.
  The fake daemon has a separate `control()` reply for health pings.
- Do not mock what you can instantiate.
- The dashboard is tested over a real `node:http` server and a real `fetch`, and
  the managed installer is tested against a real local HTTP server serving a real
  `tar.gz`. Both paths fail closed, so the negative cases (digest mismatch,
  missing manifest entry, no binary found) carry the weight.
- `tests/integration/ui-and-supervision.test.ts` covers the dashboard routes and
  daemon supervision end to end. Its supervision cases spawn a stand-in shell
  script, so assert that no child outlives the test.

## Documentation is bilingual

`README.md` (English) and `README.zh-CN.md` (Simplified Chinese) are parallel
documents, and each links to the other at the top. `tests/unit/readme.test.ts`
fails if they drift: same section count, same fenced code blocks in the same
order, and the same install commands, API surface, default verdicts, and Node
floor. When you change one, change the other in the same commit.

`DESIGN.md` is the Chinese white paper and is the source of record for the
design; `docs/` is English only. `docs/INSTALL.md` (daemon supervision and the
managed download) and `docs/UI.md` (the dashboard and the `agentjail` service)
are the two operational documents a change to `src/ui/` or `src/adapter/` should
keep current.

## Formatting

Prettier formats everything except `DESIGN.md` (authored prose, see
`.prettierignore`). Do not run Prettier over `DESIGN.md`.

## The vendored AgentJail binary

The plugin ships the AgentJail build it was tested against, so an upstream release
cannot change the engine under a plugin that was not tested against it. Three rules
keep that honest.

**The binary is not in git.** `vendor/` is gitignored; each platform's build is
about 40 MB and belongs in a release, not in history. `vendor.lock.json` is the
committed artifact: a pinned version, the per-platform asset names, and a
full-length SHA-256 for each. Edit the lock file to move to a new build; the lock
file is a reviewed change on purpose.

**Both upstream binaries are vendored.** A release archive holds `agentjail`
(41 MB, the daemon and the only copy of the OPA/Rego engine) and
`agentjail-hook` (6.7 MB, a single-shot forwarding layer). The plugin only ever
talks to the daemon, but upstream's `agentjail install` aborts without
`agentjail-hook` next to `agentjail`, so the script copies, chmods, and checks
both. `vendor:check` and the CI pack check each assert both by name, not by
counting files.

**The engine is only reachable through the daemon.** `agentjail-hook` has no
engine and FAILS OPEN when the socket is unreachable — its own embedded text
warns that a prompt-injected agent can kill the daemon and slip a command
through the window. `try --json` streams JSONL but still needs a live daemon,
the daemon has no stdio transport, and the daemonless `hook-fallback.json` path
keeps only three self-protection rules while allowing unmatched input. A
daemonless design would invert this plugin's fail-closed contract, so it was
rejected; the measurements are in `DESIGN.md` §3.3.1 and the upstream ask in
`docs/UPSTREAM-OFFLINE-EVAL.md`. Do not "simplify" this into a per-call child
process.

**The digest is checked before extraction.** `scripts/vendor-agentjail.mjs`
downloads the archive, hashes it, and refuses a mismatch before unpacking
anything. A test asserts the comparison precedes the extraction call, so the
ordering cannot regress silently. A tampered or truncated download must never
reach the filesystem as a runnable file.

**The version is checked before the daemon is started.** `src/adapter/version.ts`
parses `<binary> --no-color version` and classifies it against
`SUPPORTED_VERSION_WINDOW` (`>=1.8.0 <2.0.0`). Anything outside the window —
too old, too new, or unreadable — is refused and the plugin stays on its
`failureAction`. An unknown version is never treated as compatible. The window is
fixed per plugin release; `daemon.requireSupportedVersion: false` only turns the
check off.

`npm run vendor` fetches the running platform, `npm run vendor:all` fetches every
platform, and `npm run vendor:check` asserts the running platform's build is
present. Release runs `vendor:all` before publishing, and a CI job runs the
real-binary end-to-end suite (`AGENTJAIL_E2E=1`) against a vendored build so the
self-contained claim is tested rather than asserted.

Resolution order, highest priority first: `daemon.binary`, `AGENTJAIL_BIN`, the
vendored build, `PATH`, then the managed download directory. The vendored build is
the default, not a last resort — a missing `vendor/` (a git checkout rather than a
published package) falls through to `PATH` rather than failing.

## Packaging

`package.json` declares `dsh.bundle.patch` and `engines.dsh`, which is what makes
`dsh plugin --profile <name> add dsh-plugin-agentjail` activate a layer rather
than install a plain dependency. `scripts/check-bundle.mjs` checks both in CI.

The bundle patch `cordis.patch.yml` references the plugin by package name and by
row id `agentjail` (matching the exported `name`). `scripts/check-exports.mjs`
cross-checks that.

## Releasing

`.github/workflows/release.yml` publishes with **trusted publishing**: no npm
token is stored anywhere. The job requests `id-token: write`, GitHub mints a
short-lived OIDC token, and the npm CLI exchanges it for a publish credential
scoped to this workflow and repository. Two floors come with it — npm CLI
`>= 11.5.1` and Node `>= 22.14.0` — and the workflow asserts the npm version
before publishing rather than relying on a token fallback that no longer exists.

A maintainer configures the npm side once, in the package's **Settings →
Trusted publishing** (GitHub Actions, `axetroy` / `dsh-plugin-agentjail` /
`release.yml`). The configuration expires if it does not complete a first publish
within two days. Provenance is automatic under trusted publishing, so the
workflow does not pass `--provenance`; `publishConfig` in `package.json` records
`access: public` and `provenance: true` for a manual publish.

Do not reintroduce `NPM_TOKEN` or any `NODE_AUTH_TOKEN` into this workflow. If a
release fails at publish, check the trusted-publisher configuration and the npm
CLI version before reaching for a secret.

### Versions and the changelog

Versions and `CHANGELOG.md` are owned by
[changesets](https://github.com/changesets/changesets), not by hand. Record every
user-visible change as a changeset (`npm run changeset`, or a `.md` file under
`.changeset/` with a `'dsh-plugin-agentjail': patch|minor|major` frontmatter
block). `changesets/action` in `release.yml` then opens a "Version Packages" pull
request that runs `changeset version` (bumping `package.json`, consuming the
changesets, writing the changelog) and, once merged, publishes.

Two rules keep this working:

- Do not hand-edit a released section of `CHANGELOG.md`. From `0.2.0` on the
  sections are generated; only `0.1.0` is hand-written. A change with no changeset
  is a change that never ships.
- Keep version headings in the `## 0.2.0` form. changesets locates the insertion
  point with `^#{1,6}\s+\d+\.\d+`, so a bracketed `## [0.2.0]` heading does not
  match and the new section lands above the intro instead of below the newest
  release. `tests/unit/manifest.test.ts` asserts the release workflow is
  changeset-driven.

## Test coverage

`vitest.config.ts` enforces a 90% floor on statements, branches, functions, and
lines. Measured values sit a point or two above, so ordinary churn does not trip
it; a change that drops a metric below 90 fails `npm run test:coverage` and CI.
When adding a module, add tests for the branches the happy path skips — a missing
`agent`, an absent optional field, a sink that throws — rather than loosening the
floor.

## Security scanning

CodeQL runs the `security-and-quality` query pack, so it reports more than the
default security suite. Two findings shaped the code and should not be undone:

- `js/unvalidated-dynamic-method-call` (high) fired on the test's route
  dispatcher, which invoked a handler read from a `Map` keyed by the request URL.
  `fakeServer().dispatch` now narrows the value with a `typeof` guard, so a miss
  and an unexpected shape both become a 404 rather than a call. The production
  route table is not keyed by request input; only the test helper was.
- `js/http-to-file-access` (medium) fired on the installer writing a downloaded
  archive. The tag can arrive from a redirect target, so it is untrusted.
  `isSafeReleaseTag` restricts it to a release-tag shape and `joinInside` asserts
  the write stays under the working directory, so a tag like `../../etc/passwd`
  is rejected before any request is made. The write itself is the point of the
  module, and it happens only past a SHA-256 comparison against the manifest.
  CodeQL does not model a digest comparison as a sanitizer, so this one flow
  carries an inline `// codeql[js/http-to-file-access]` with the reason written
  above it. That is the only suppression in the tree; keep it that way, and keep
  the reason next to it.

## Inline suppressions need two steps, not one

GitHub code scanning does **not** act on the SARIF `suppressions` property. A
CodeQL maintainer states it plainly in
[codeql-action#1230](https://github.com/github/codeql-action/issues/1230):
"Code scanning does not support suppressions. ... It will be ignored by code
scanning." The alert state enum has no `suppressed` value either, only `open`,
`dismissed`, and `fixed`. So an inline `codeql[...]` comment by itself closes
nothing, no matter where it is placed.

Making a suppression real takes both of these in `codeql.yml`:

1. `packs: codeql/javascript-queries:AlertSuppression.ql` on `init`. The
   alert-suppression query is not in the default suite, so without this the
   comment is not even parsed and the SARIF carries no `suppressions` entry.
2. The `advanced-security/dismiss-alerts` step after `analyze`. It reads the
   local SARIF, matches suppressed results to alerts by rule id, file, line, and
   column, and dismisses them through the API — and re-opens an alert whose
   suppression was removed. It runs on `main` only, since a dismissal is
   repository state, not a per-PR fact.

If you remove either step, the installer alert reopens with no other change.
Both are covered by tests in `tests/unit/manifest.test.ts`.

Prefer fixing a CodeQL finding by validating the input at its source. Use an
inline `codeql[js/...]` comment only when the flow is provably benign, put the
reason immediately above it, and place the comment on the line before the
flagged line — that is the only position the suppression covers. Never write a
literal `codeql[...]` outside a real suppression comment: the suppression query
matches the text anywhere, including a comment that merely mentions the syntax,
and produces a bogus suppression range.

## The no-match signal

AgentJail's engine reports "no rule matched" as a bare `{"action": "allow"}` with
no `rule_id` — that is its own default decision (`agentpolicy/policies/default.rego`),
and the daemon's resolver labels a synthesized default `resolver/default`, which
its hook treats as "not a real rule". The plugin reads any of those as a no-match
and applies the configured `defaultAction`. A rule-backed allow always names its
`rule_id`, and a `would_action` means a rule matched in monitor mode, so neither is
a no-match.

This is why `renderEntrypoint` emits an explicit
`{"action": "allow", "rule_id": "default/allow"}` for a no-match instead of a bare
`allow`: the shipped templates are denylists, and without the id their permits
would be read as no-matches and `defaultAction: deny` would turn them into
deny-everything policies. `DEFAULT_ALLOW_RULE_ID` in `src/security/policy.ts` is
the shared constant; a real-OPA test in `tests/unit/policy.test.ts` pins it.

When adding a verdict field to the schema, wire it into `resolveDecision` and
cover it with a test. Several fields once shipped read-but-unused
(`defaultAction`, `askFallback`, `alertsEnabled`, the deny-rate alert, the
reconnect backoff), which is worse than not having them: the configuration looks
enforced and is not.
