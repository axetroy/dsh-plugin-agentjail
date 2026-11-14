# Local development

How to run this plugin on your own machine, see a change take effect in the
Harness UI, and test it without a browser or a daemon.

## One-time setup

```sh
git clone https://github.com/axetroy/dsh-plugin-agentjail
cd dsh-plugin-agentjail
npm ci
npm run build
```

`npm ci` installs the toolchain. `npm run build` produces three things:

| Artifact        | What it is                                                         |
| --------------- | ------------------------------------------------------------------ |
| `lib/index.js`  | the Host half — the Cordis plugin the Harness loads                |
| `lib/client.js` | the browser half — the lazy-CJS factory the client loader calls    |
| `lib/types/`    | declarations for both, so a consumer type-checks against real code |

The browser half is the part people forget. It is a **separate artifact with a
separate build step**, and a change under `src/client/` does not appear in the UI
until you rebuild it.

## Wiring the checkout into a running Harness

`dsh plugin` creates a profile from `@deepseek-ai/dsh-base`, which has no web UI.
Start from the shipped `web` template instead, then install the checkout into it.
The Harness documents installing a local plugin by path:

```sh
npm run build
dsh --profile dev --from-default-profile web   # a web-UI profile, once
dsh plugin --profile dev add "$(pwd)"          # installs this checkout
dsh --profile dev                              # web UI on http://127.0.0.1:3080
```

The AgentJail section appears in **Settings**, next to General and Plugins.

Install by path rather than copying `lib/` somewhere by hand. The Harness
discovers the browser half by reading the nearest package manifest for the
Loader row and looking for `dsh.client`, so the plugin has to be resolvable as a
package with its `package.json` next to `lib/`. A loose `lib/client.js` is never
found.

To iterate without reinstalling, point a patch overlay at the checkout instead.
`--patch` takes a file path and resolves a plugin path relative to it, and the
Harness requires that path to be absolute:

```sh
cat > dev.patch.yml <<YAML
- insert:
    - id: agentjail-dev
      name: $(pwd)
      config:
        enforcement: monitor
YAML
npm run build
dsh --profile dev --patch ./dev.patch.yml
```

Use the overlay in a profile that has **not** installed the bundle: the two would
otherwise both insert a row, and the row id has to differ from the bundle's
`agentjail`. A patch replaces the whole `config` for its row, so that overlay
drops every other default — `examples/monitor.patch.yml` is the full worked
version, and is what to copy when you want a real overlay rather than the smallest
thing that boots.

The section's data comes from `/agentjail/api/summary` on the same origin, so the
same web server has to be the one serving the UI.

## The edit loop

Two watchers, because there are two halves.

Host half — `src/index.ts`, `src/hooks/`, `src/adapter/`, `src/security/`,
`src/ui/`:

```sh
npm run dev          # tsdown --watch, rewrites lib/ on save
```

Reload the Harness after a rebuild. The Host half is loaded by Node, so a page
refresh is not enough.

Browser half — `src/client/`:

```sh
npm run build:client # tsc -p tsconfig.client.json && node scripts/build-client.mjs
```

Then hard-reload the page. The web server caches `lib/client.js`, so a normal
reload can serve the previous bundle.

`npm run build` runs both, plus the Host bundle, and is what CI checks.

## Running against a real policy engine

The plugin works with no daemon — it fails closed and says so — but a real engine
is what you want while writing policy. The published package ships a vendored
build, so you can point the plugin at the checkout's own copy. `npm run vendor`
fetches the build for the machine you are on, so the path matches your platform:

```sh
./vendor/linux-amd64/agentjail daemon --socket /tmp/agentjail-dev.sock
```

On macOS the directory is `vendor/darwin-arm64` or `vendor/darwin-amd64` instead.
Development is Linux or macOS; the plugin has no Windows path (see
`docs/INSTALL.md`).

Or, with an `agentjail` on `PATH`:

```sh
agentjail daemon --socket /tmp/agentjail-dev.sock
AGENTJAIL_SOCKET=/tmp/agentjail-dev.sock dsh --profile dev
```

Check what the plugin sees:

```sh
curl -s localhost:3080/agentjail/api/health | jq
curl -s localhost:3080/agentjail | head -20
curl -s 'localhost:3080/agentjail/api/decisions?verdict=deny&limit=5' | jq
```

A `supervision: external` line means the plugin adopted the daemon you started and
will not signal it on unload. That is the state you want while developing.

## Testing

```sh
npm run verify         # format:check + lint + typecheck + build + test, as CI runs it
npm test               # the whole suite
npm run test:coverage  # with the 90% floor enforced
npx vitest             # watch mode
```

Narrow to what you changed:

```sh
npx vitest run tests/unit/client-face.test.ts      # transport and slot registration
npx vitest run tests/unit/client-section.test.tsx  # the section, in jsdom
npx vitest run tests/unit/client-bundle.test.ts    # the built lib/client.js, as loaded
npx vitest run tests/unit/dashboard.test.ts        # the text and JSON routes
npx vitest run tests/unit/manifest.test.ts         # packaging, client declaration, release
```

Four notes on the test suite:

- The enforcement tests are the ones that matter. `tests/integration/plugin.test.ts`
  mounts the plugin on a real Cordis runtime and asserts that a denied call's body
  never ran. Extend those for anything on the enforcement path.
- `tests/unit/client-bundle.test.ts` evaluates the built `lib/client.js` in a
  stand-in module table, so a lost registration or an inlined React copy fails
  the suite. It needs `npm run build:client` first, which is why CI builds before
  it tests.
- The browser half is tested without a browser. The only stand-in is
  `@deepseek-ai/dsh-client-ui-primitives`, aliased in `vitest.config.ts`, because
  the real package ships CSS modules that Node cannot import. `tsc` still
  type-checks against the published declarations, so a props change fails the
  build rather than passing silently.
- `AGENTJAIL_E2E=1` turns on the real-daemon tests, which need `npm run vendor`
  first. They are skipped otherwise.

## Policy templates

`policy/` is generated from `src/security/policy.ts`, and a test fails if the two
drift. After editing a template:

```sh
npm run build
node -e "
  const { resolveTemplates, writeTemplateBundle, POLICY_TEMPLATES } = await import('./lib/security/policy.js')
  await writeTemplateBundle('policy', resolveTemplates(POLICY_TEMPLATES.map((t) => t.name)))
"
opa check policy/
```

## When the section does not appear

In order:

1. Did you run `npm run build:client` after the last `src/client/` change?
2. Is the Harness serving the profile that has the plugin, and does that profile
   include the web app? Check `dsh plugin --profile dev list`; a profile
   `dsh plugin` created on its own is base only, and has no Settings dialog to
   register into.
3. Does `lib/client.js` start with `window.__ModuleLoader__.load(`? Run
   `node scripts/check-exports.mjs` — it checks the banner, the id, the
   `settings.section` registration, and that React stayed external.
4. Open the browser console. A section that throws during registration is logged
   by the client loader; a section that registers but shows a red banner has a
   data problem, not a registration problem.
5. `curl localhost:3080/agentjail/api/health`. If the route is missing, the web
   server was not composed or `ui.enabled` is false.

## Where the contract is written down

The Harness documents the two mechanisms this plugin uses, and both are worth
reading before changing `src/client/` or the `dsh` block in `package.json`:

- [`reference/subsystems/client-modules`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
  — how `dsh.client` is scanned, and the lazy-CJS factory `./client` must be.
- [`reference/subsystems/slots`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)
  — `slots.inject` / `slots.register` and the effect lifecycle.
- [`reference/cookbook/adding-a-settings-card`](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)
  — a worked example of a browser half contributing to Settings.

## What not to change

`AGENTS.md` lists the invariants a change must not break, and they are worth
reading before touching `src/security/` or `src/hooks/`: nothing turns an unknown
into an allow, the gate never throws, denials are re-asserted, and redaction runs
before any sink. The panel is a view of that path; it has no write route, and it
should not gain one.
