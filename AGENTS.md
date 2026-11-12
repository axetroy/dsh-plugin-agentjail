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

| Path | Role |
|---|---|
| `src/index.ts` | `apply()`, listener registration, `ctx.provide('agentjail', …)` |
| `src/hooks/` | `tools/pre-execute` gate, post-execute observer, approval answerer |
| `src/security/` | decision resolution, normalization, grants, policy templates, redaction |
| `src/adapter/` | socket connection, protocol frames, caching client |
| `src/audit/`, `src/governance/` | audit trail, metrics, reports |
| `src/config/schema.ts` | Schemastery config; `Config` interface + schema export |
| `policy/` | Generated Rego bundle (see below) |
| `scripts/` | CI helper checks (`check-exports.mjs`, `check-bundle.mjs`) |

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
