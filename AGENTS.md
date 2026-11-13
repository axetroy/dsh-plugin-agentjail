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
| `src/adapter/supervisor.ts`     | locate and start a daemon; never adopts or stops a foreign one          |
| `src/adapter/installer.ts`      | opt-in managed download with SHA-256 verification                       |
| `src/ui/`                       | read-only dashboard rendering and its HTTP routes                       |
| `src/audit/`, `src/governance/` | audit trail, metrics, reports                                           |
| `src/config/schema.ts`          | Schemastery config; `Config` interface + schema export                  |
| `policy/`                       | Generated Rego bundle (see below)                                       |
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

An inline suppression is inert unless the alert-suppression query runs, and it
is not in the default suite. `codeql.yml` therefore passes
`packs: codeql/javascript-queries:AlertSuppression.ql` to `init`. Remove that
line and the comment above the write stops working — the alert reopens with no
other change, which is a confusing way to find out.

Prefer fixing a CodeQL finding by validating the input at its source. Use an
inline `codeql[js/...]` comment only when the flow is provably benign, put the
reason immediately above it, and place the comment on the line before the
flagged line — that is the only position the suppression covers.
