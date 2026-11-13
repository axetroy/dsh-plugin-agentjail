# Contributing

Thanks for considering a contribution. This project is a security control, so the
process is a little stricter than a typical library's.

## Getting set up

```sh
git clone https://github.com/axetroy/dsh-plugin-agentjail.git
cd dsh-plugin-agentjail
npm ci
npm run verify
```

`npm run verify` runs format checking, lint, typecheck, tests, and the build. It
is the same sequence CI runs, so a green run locally means a green run there.

The Node floor is `22.18.0`, not because the runtime code needs it but because
the build toolchain (`tsdown` and its rolldown plugin) does, and `prepare` runs
the build during `npm ci`. Node 22.18 and 24 are both tested in CI.

## The one rule that matters

**Any change touching the enforcement path must explain why it cannot turn a deny
into an allow.**

The enforcement path is:

- `src/hooks/pre-tool-use.ts`
- `src/security/decision.ts`
- `src/security/grants.ts`
- `src/index.ts` (the listener registrations)

For those files, the pull request template asks you to state the argument. "It
seems fine" is not an argument. "A transport failure can only reach step 6 of
`resolveDecision`, and step 6 applies `failureAction`, which this change does not
touch" is.

## Testing

Three layers, and they test different things.

| Layer       | Location                              | What it proves                                                                                |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/`                         | Pure logic: normalization, verdict resolution, redaction, grants, metrics, policy rendering.  |
| Adapter     | `tests/unit/agentjail-client.test.ts` | The client against a real Unix socket served by an in-process fake daemon.                    |
| Integration | `tests/integration/plugin.test.ts`    | The plugin mounted on a real Cordis runtime with the real `ToolsService` and native executor. |

The integration layer is the one that matters for enforcement. It registers real
tools and asserts that a denied call's body never ran. If you change the
enforcement path, that assertion is the evidence your change is safe, so extend
it rather than working around it.

Do not use mocks where a real object is available. The fake daemon is a real
socket server, not a stubbed client, precisely so the adapter tests exercise the
framing and the timeout logic.

### Testing policy

The Rego templates are validated against a real OPA binary when one is on `PATH`
or `OPA_BIN` is set:

```sh
# Install OPA, then:
opa check policy/
npm run test -- tests/unit/policy.test.ts
```

Without OPA, those tests skip and say so. A change to `src/security/policy.ts`
that cannot be evaluated should not be merged, because the failure mode of a
broken policy is a silently permissive one.

### Regenerating the checked-in policy bundle

`policy/` is generated from `src/security/policy.ts`, and a test fails if the two
drift. After changing a template:

```sh
npm run build
node -e "
  const { resolveTemplates, writeTemplateBundle, POLICY_TEMPLATES } = await import('./lib/security/policy.js')
  await writeTemplateBundle('policy', resolveTemplates(POLICY_TEMPLATES.map((t) => t.name)))
"
```

## Style

- Formatting and most style rules are enforced by Prettier and ESLint. Run
  `npm run format` and `npm run lint:fix` before committing.
- Comments explain _why_, never _what_. A comment that restates the line below it
  will be asked to leave.
- Documentation comments on exported symbols are required; the build is
  configured to carry them into the `.d.ts` output.
- Prefer a small, total function over a large one with modes. `normalizeToolCall`
  and `resolveDecision` are the shape to aim for.

## Commits and pull requests

- Conventional-commit subjects (`feat:`, `fix:`, `docs:`, `chore:`, `test:`)
  make the changelog mechanical. They are not enforced, but they are appreciated.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` when the change is
  user-visible.
- One pull request per concern. A formatting sweep mixed into a behavior change
  makes the behavior change unreviewable.
- The PR template's security-impact section is required, not optional.

## Suppressing a CodeQL alert

Code scanning does not honor the SARIF `suppressions` property, so an inline
`codeql[...]` comment alone closes nothing. Suppression takes two steps in
`codeql.yml`, and a test in `tests/unit/manifest.test.ts` asserts both are
present: the `AlertSuppression.ql` pack on `init`, which is what marks a result
as suppressed, and the `advanced-security/dismiss-alerts` step, which turns that
mark into a dismissal through the API. Both are explained in `AGENTS.md`.

Prefer fixing a finding by validating its input. Reach for a suppression only
when the flow is provably benign, and write the reason directly above the
comment. Do not write the literal `codeql[...]` text in a comment that is not a
suppression — the suppression query matches the text wherever it appears.

## Documentation

Behavior changes need a documentation change in the same pull request. The
relevant files:

- `README.md` — install, configure, and the guarantees table.
- `docs/CONFIGURATION.md` — every field, its default, and what changing it costs.
- `docs/POLICY.md` — normalization and the templates.
- `docs/OPERATIONS.md` — running it and responding to incidents.
- `docs/THREAT-MODEL.md` — what the plugin does not defend against.
- `SECURITY.md` — the reporting process and the in/out-of-scope list.

A new configuration field belongs in `docs/CONFIGURATION.md` and in the shipped
`cordis.patch.yml`, with the safe value as the default.

## Releasing

Maintainers only.

1. Move `## [Unreleased]` in `CHANGELOG.md` to a new version heading with today's
   date, and add a comparison link.
2. Bump `version` in `package.json` to match.
3. Commit, then tag `v<version>` and push the tag.
4. The release workflow verifies the tag matches `package.json`, runs the full
   suite, publishes to npm with provenance, and opens a GitHub release.

A tag that does not match `package.json` fails the workflow before publishing,
which is deliberate: a version skew between the registry and the repository is
hard to notice and annoying to correct.

### Publishing uses trusted publishing, not a token

The workflow holds no npm token. It requests `id-token: write`, GitHub mints a
short-lived OIDC token, and the npm CLI exchanges that for a publish credential
scoped to this workflow and repository. A leaked log or a read of the workflow
file therefore yields nothing reusable, and there is no secret to rotate.

This is a one-time setup that a maintainer performs once, on npmjs.com:

1. Open the package's **Settings → Trusted publishing → Add trusted publisher**.
2. Choose **GitHub Actions** and fill in:
   - **Organization or user**: `axetroy`
   - **Repository**: `dsh-plugin-agentjail`
   - **Workflow filename**: `release.yml` (the file name only, with the `.yml`)
3. Save. The configuration must complete its first successful publish within two
   days or it expires and must be recreated.
4. Recommended, once a publish has succeeded: **Settings → Publishing access →
   "Require two-factor authentication and disallow tokens"**. That setting does
   not affect trusted publishers, which authenticate with OIDC.

Two version floors come from trusted publishing: npm CLI `>= 11.5.1` and Node
`>= 22.14.0`. The workflow pins Node 24 and asserts the npm version before it
publishes, so a runner image that ships an older CLI fails loudly instead of
falling back to a token that is not there.

Provenance is generated automatically for a public package published from a
public repository, so the workflow does not pass `--provenance`. If you publish
by hand from a laptop, run `npm publish --access public`; `publishConfig` in
`package.json` already sets `access: public` and `provenance: true`.

## License

By contributing, you agree your contribution is licensed under
[Apache-2.0](LICENSE), as described in section 5 of that license.
