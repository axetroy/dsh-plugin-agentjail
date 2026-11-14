# dsh-plugin-agentjail

**English** | [简体中文](./README.zh-CN.md)

An AI agent tool security gateway for DeepSeek Harness.

Every tool call an agent makes passes through this plugin before it reaches the
tool. The plugin asks [AgentJail](https://github.com/LuD1161/agentjail) — a
policy daemon backed by Open Policy Agent — whether the call is allowed, and
applies the answer. A call the policy denies never runs.

```
agent → tool call → tools/pre-execute → DH-AgentJail → AgentJail daemon → OPA / Rego
                                              │
                          allow ──────────────┤────────────── deny
                            │                                   │
                     tool body runs                    tool body never runs
                            │                                   │
                            └──────────────► audit record ◄──────┘
```

The design is written up in [`DESIGN.md`](./DESIGN.md) (Chinese). This README is
the practical guide.

## Why this exists

A tool permission system usually answers one question: is this tool available?
That is not the question that matters. The question is whether _this call_, with
_these arguments_, in _this session_, should run. `rm -rf /` and `ls` are the
same tool.

This plugin moves the decision to the moment before execution and hands it to a
policy engine, so the answer is written in Rego, versioned, reviewed, and
audited — instead of being implied by the tool list.

## Guarantees

These hold on every code path, and the test suite exists mostly to prove them.

| Guarantee                                                                 | How it is enforced                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| An unreachable, timing-out, or unparseable engine never becomes an allow. | Every transport failure resolves the configured `failureAction`, whose default is `deny`.                                                      |
| A denied call's body never runs.                                          | The verdict is returned from `tools/pre-execute`; the registry does not call the tool. The integration suite asserts the body did not execute. |
| A later listener cannot re-open a denied call.                            | A monotonic `ctx.tools.guard` re-asserts the resolved denial. A guard has no allow result.                                                     |
| Every decision is recorded.                                               | One audit record per evaluation, including failures and grant reuse.                                                                           |
| A grant authorizes exactly one action.                                    | Grants bind session, tool, and argument digest, and are consumed on use.                                                                       |
| An unanswerable `ask` fails closed.                                       | With no approval service composed, `ask` resolves to `deny` and the audit record says why.                                                     |
| The gate never throws.                                                    | A thrown listener surfaces to the model as a generic tool failure, which is indistinguishable from a policy denial and useless as a signal.    |

## Install

The plugin is a DeepSeek Harness bundle: an npm package that ships a Cordis
configuration layer.

```sh
# 1. Create a web-UI profile. Installing into a profile `dsh plugin` creates on
#    its own gives you @deepseek-ai/dsh-base, which has no web UI, and the
#    Settings panel is where this plugin's report renders.
dsh --profile secure --from-default-profile web

# 2. Install the plugin. The published package carries the AgentJail build it was
#    tested against, so installing the plugin installs the engine.
dsh plugin --profile secure add dsh-plugin-agentjail

# 3. Start the harness. The web UI is on http://127.0.0.1:3080.
dsh --profile secure
```

Nothing else is needed. The plugin starts the AgentJail daemon it ships.

### Do I need to install AgentJail separately?

No. That is the point of vendoring: the plugin and the engine version move
together, so an upstream release cannot change the binary underneath a plugin
that was not tested against it.

The plugin resolves a binary in this order and takes the first that works:

| Order | Source             | When it is used                                            |
| ----- | ------------------ | ---------------------------------------------------------- |
| 1     | `daemon.binary`    | An explicit path. Always wins, for pinning your own build. |
| 2     | `AGENTJAIL_BIN`    | An explicit path in the environment.                       |
| 3     | **Vendored build** | The build shipped inside the package. The default.         |
| 4     | `PATH`             | An `agentjail` you installed yourself.                     |
| 5     | Managed download   | Only with `daemon.managedInstall: true`.                   |

Before it starts anything, the plugin runs `<binary> --no-color version` and
refuses a build outside its supported window (`>=1.8.0 <2.0.0`). A refused binary
leaves the plugin denying protected calls rather than running an engine it does
not understand. The window is fixed for a given plugin release; set
`daemon.requireSupportedVersion: false` to skip the check entirely.

A daemon is used, started, or left alone as follows:

- **A daemon is already answering.** The plugin uses it and touches nothing. A
  daemon you started through systemd, launchd, or `agentjail install` keeps its
  own lifecycle. Set `daemon.supervise: false` to opt out of supervision
  entirely.
- **No daemon is answering.** The plugin starts the resolved binary as
  `agentjail daemon`, on a private socket under its own state directory, and
  stops it again when the plugin unloads. It passes `--socket`, `--db`, and
  `--log` explicitly, because the daemon does not read `AGENTJAIL_SOCKET`, and it
  gives the daemon a private `HOME` so the daemon cannot reach a stale control
  plane left by an unrelated install.
- **`daemon.binary` points at a binary.** That binary is used and the vendored
  build is ignored.

`docs/INSTALL.md` covers each case, the search order, and the residual trust
question in the managed download.

```sh
# Optional: own the daemon yourself instead of letting the plugin manage it.
curl -fsSL https://raw.githubusercontent.com/LuD1161/agentjail/main/install.sh | sh
```

The install appends this package to the profile's `dsh.profile.bundles` list
because the package declares `dsh.bundle`. Confirm the layer is present, then
boot:

```sh
ls -l "$HOME/.agentjail/daemon.sock"   # the daemon socket the plugin targets
dsh --profile secure --dump-config     # shows a "# == dsh-plugin-agentjail" layer
dsh --profile secure
```

Installing from a git host fetches sources, not build output, so pnpm runs the
package's `prepare` script and needs explicit permission first. Pin a commit so a
later push cannot change what runs:

```sh
dsh plugin --profile secure add github:axetroy/dsh-plugin-agentjail#v0.1.0
# pnpm refuses the build script once; copy the printed key into the profile's
# pnpm-workspace.yaml under `allowBuilds`, then re-run the add.
```

A missing socket is not fatal. The plugin loads, reports that the engine is
unavailable, and denies every protected call until the daemon appears. That is
the intended behavior: an agent without a policy engine should not be running
tools.

### Requirements

- Node.js `>=22.18.0`
- DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`
- Linux or macOS, on `x64` or `arm64`. **Windows is not supported.** The plugin
  runs the AgentJail daemon from a build vendored per platform, and upstream
  publishes no Windows build; the daemon also speaks only over a Unix domain
  socket, which Windows does not have in the form this plugin needs. On any other
  platform the plugin still loads, logs a warning, and denies every protected
  call — it fails closed rather than open. `package.json` declares `os` and `cpu`,
  so an unsupported platform is refused at `npm install` instead of silently at
  runtime.
- Nothing else. The AgentJail engine ships with the plugin; override it with
  `daemon.binary` only if you want to.

## Configure

Configuration lives in the `agentjail` row of your profile's
`cordis.patch.yml`. Every field has a default; the shipped row is the safe
starting point. A patch replaces a row's whole `config`, so restate every key you
keep.

```yaml
- insert:
    - id: agentjail
      name: dsh-plugin-agentjail
      config:
        enforcement: enforce # enforce | monitor
        socketPath: '' # '' → $AGENTJAIL_SOCKET → ~/.agentjail/daemon.sock
        timeoutMs: 2000
        failureAction: deny # verdict when the engine cannot be reached
        defaultAction: deny # verdict when no rule and no override match
        askAction: ask # ask | deny
        askFallback: native # native (Harness approval) | deny
        exemptTools: [] # bypass the engine entirely
        cache:
          enabled: true
          maxEntries: 1024
          ttlMs: 5000
        audit:
          storage: file # file | memory | none
          filePath: '' # '' → $AGENTJAIL_DSH_AUDIT_PATH → ~/.agentjail/dsh-audit.jsonl
          redactSensitiveData: true
        daemon:
          supervise: true # start a daemon when none is answering
          binary: '' # '' → $AGENTJAIL_BIN → PATH → managed download
          managedInstall: false # download a release binary when none is found
        ui:
          enabled: true # register the panel data routes on a web server
          basePath: /agentjail
```

`docs/CONFIGURATION.md` documents every field, its default, and what changing it
costs. The short version:

- Do not set `failureAction` or `defaultAction` to `allow`. Both exist for
  deliberate, temporary debugging.
- Start a new policy in `enforcement: monitor`. It records what it _would_ have
  blocked and blocks nothing. Read the audit trail, fix the policy, then switch
  to `enforce`.
- Leave `exemptTools` empty. Each entry is a tool that runs unexamined.

### Environment variables

| Variable                   | Effect                                                  |
| -------------------------- | ------------------------------------------------------- |
| `AGENTJAIL_SOCKET`         | Daemon socket path, used when `socketPath` is empty.    |
| `AGENTJAIL_DSH_AUDIT_PATH` | Audit file path, used when `audit.filePath` is empty.   |
| `AGENTJAIL_BIN`            | Daemon binary path, used when `daemon.binary` is empty. |

## Policies

Rego evaluation stays in AgentJail's engine. This plugin translates and enforces;
it does not re-implement policy. Six reviewed templates ship under
[`policy/`](./policy) to start from:

| Template               | Posture                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `read-only`            | Deny every mutation; reads pass to the remaining rules.            |
| `no-credential-access` | Deny reads of keys, cloud credentials, and `.env` files.           |
| `no-remote-execution`  | Deny piping a download into a shell, and base64-decoded execution. |
| `restricted-egress`    | Deny calls to cloud metadata endpoints and private address ranges. |
| `approve-mutations`    | Route writes and destructive commands to `ask` instead of `deny`.  |
| `mcp-allowlist`        | Deny MCP tools outside an approved server set.                     |

```sh
# Write the rendered bundle to a directory the daemon loads.
node -e "
  const { resolveTemplates, writeTemplateBundle } = await import('dsh-plugin-agentjail/policy')
  await writeTemplateBundle('/etc/agentjail/policies', resolveTemplates(['read-only', 'no-credential-access']))
"
```

`docs/POLICY.md` explains how a call is normalized into AgentJail's vocabulary,
what the templates cover, and how to write your own rule.

## Approvals

When policy returns `ask`, the plugin asks Harness's approval service. If a UI
answerer is composed, the user sees a prompt. If none is composed, the call is
denied — an unanswered question is not a yes.

Approving a call issues a grant. A grant is bound to the session, the tool, and a
digest of the exact arguments, and is consumed on use. Approving
`git push origin main` does not authorize `git push origin main --force`; the
digests differ. `docs/CONFIGURATION.md` covers grant lifetime and revocation.

## Audit and reporting

Each decision appends one JSON Lines record:

```json
{
  "version": 1,
  "seq": 42,
  "timestamp": "2026-11-12T10:31:07.512Z",
  "requestId": "req_7f3a…",
  "sessionId": "session_9c1e…",
  "toolName": "bash",
  "jailToolName": "Bash",
  "verdict": "deny",
  "source": "engine",
  "ruleId": "no-remote-execution",
  "reason": "Piping a download into a shell is not permitted",
  "arguments": { "command": "curl -s https://… | sh" },
  "digest": "sha256:…",
  "durationMs": 3
}
```

`source` tells you where a verdict came from — `engine`, `cache`, `override`,
`exempt`, `default`, `grant`, or `failure-action`. A trail full of
`failure-action` means the daemon is down, not that the agent is behaving badly.

The plugin exposes an `agentjail` service for operational queries:

```ts
ctx.agentjail.health() // link state, last error, daemon version
ctx.agentjail.stats() // sliding-window risk statistics
ctx.agentjail.queryAudit({ verdict: 'deny', limit: 50 })
ctx.agentjail.reportText() // a readable security report
ctx.agentjail.listGrants() // outstanding approvals
ctx.agentjail.revokeSession(sessionId) // drop a session's approvals
ctx.agentjail.grantSession({ toolName, sessionId, digest }) // authorize a repeat call
ctx.agentjail.writePolicyTemplates() // render configured templates to disk
ctx.agentjail.reloadPolicy() // ask the daemon to reload, then drop cached verdicts
ctx.agentjail.invalidateCache() // drop cached verdicts only
ctx.agentjail.dashboard() // the dashboard payload, as JSON-ready data
ctx.agentjail.dashboardText() // the dashboard as fixed-width text
ctx.agentjail.supervision() // 'external' | 'started' | 'exited' | 'unavailable' | 'disabled'
ctx.agentjail.ensureDaemon() // start a daemon if none is answering
```

`docs/OPERATIONS.md` covers rotation, retention, alerting, and incident
response.

## Settings panel

Every decision the plugin makes is already recorded. The panel renders that record
while the agent runs, so an operator can watch a session instead of reading the
audit file afterwards.

It is not a page the plugin serves itself. The plugin ships a browser half that
the Harness client module system loads, and that half registers one **Settings
section** through the official slot mechanism — `settings.section`, the same seat
every built-in settings page occupies. Open **Settings** in the Harness UI and the
AgentJail section is there, next to General and Plugins. It appears and disappears
with the plugin: unloading the plugin removes the section through the disposer the
slot service returns, and no Harness file is edited.

```
Settings
├── General
├── AgentJail     ← this plugin: engine, decisions, approvals, alerts
└── Plugins
```

The section is a read-only view: it cannot widen a policy, clear a denial, or
change `failureAction`. Nothing in it is clickable except Refresh, because a
reporting surface that could do those things would be a larger attack surface
than the gate it reports on.

### Data routes

The section is a view, so the Host supplies data only. When a Harness web server
is composed (`dsh web`, default port 3080), the plugin registers the read-only
JSON routes below. Nothing is registered when no web server is present, so the
CLI and the desktop app are unaffected, and the panel simply has no data source.

| Endpoint                   | Returns                                               |
| -------------------------- | ----------------------------------------------------- |
| `/agentjail/api/summary`   | Counts, health, supervision, approvals, recent rows.  |
| `/agentjail/api/decisions` | Audit records; filter with `?verdict=` and `?limit=`. |
| `/agentjail/api/health`    | Engine state, socket, supervision, failure posture.   |
| `/agentjail`               | The same summary as fixed-width text, for `curl`.     |

`GET /agentjail` is content-negotiated: `?format=json` returns the summary JSON,
anything else returns text. A browser navigating to `/agentjail` gets the text
too, because the rich view lives in Settings now.

```
$ curl localhost:3080/agentjail
AgentJail security dashboard
generated   2026-11-12T10:31:07.512Z
enforcement enforce  failure deny  default deny
engine      healthy  (/home/you/.agentjail/daemon.sock)
supervision external

decisions   18  allow 15  deny 2  ask 1
deny rate   11.1%
approvals   1

recent decisions:
       7  2026-11-12T10:31:05.100Z  deny   bash  no-remote-execution
```

The Host advertises the route's base path to the browser half as a `global` index
injection row, so moving `ui.basePath` in your profile still points the section at
the right endpoint. `docs/UI.md` documents the panel, the routes, and the client
slot contract.

## What this does not do

Read [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md) before relying on this in
production. The short version, from the design's own risk section:

Intercepting `tools/pre-execute` governs what the agent _asks for_. It does not
govern what an allowed process then does. An approved `bash` call can spawn other
processes, open sockets, or write files that no rule saw. The plugin is one layer
of a defense-in-depth posture; AgentJail's OS sandbox and network tunnel are the
others, and this plugin does not replace them.

## Development

```sh
npm ci
npm run verify      # format, lint, typecheck, build, test
```

| Command                 | What it does                                |
| ----------------------- | ------------------------------------------- |
| `npm run build`         | Bundle the Host half, then the client half. |
| `npm run build:client`  | Rebuild `lib/client.js` alone.              |
| `npm run typecheck`     | `tsc --noEmit`.                             |
| `npm run lint`          | ESLint with type-aware rules.               |
| `npm test`              | Vitest, unit and integration.               |
| `npm run test:coverage` | The same, with coverage.                    |
| `npm run format`        | Prettier.                                   |

### Local development

`docs/DEVELOPMENT.md` has the full loop. The short version:

`npm run dev` rebuilds the Host half on every save, so a running Harness that has
the plugin installed picks up each change:

```sh
npm link            # make this checkout resolvable by name
npm run dev         # tsdown --watch, rebuilds lib/ on save
```

The browser half is a separate artifact. `npm run build:client` compiles the
client types and bundles `src/client/` into `lib/client.js` — the lazy-CJS factory
the Harness client module system loads. The Harness web server caches that file,
so after changing anything under `src/client/` rebuild and reload the page. The
whole loop is:

```sh
npm run build:client   # tsc -p tsconfig.client.json && node scripts/build-client.mjs
# then reload the Harness UI; the AgentJail section re-registers on load
```

To work against a real policy engine rather than a fake daemon, start one and
point the plugin at it:

```sh
agentjail daemon --socket /tmp/agentjail-dev.sock
AGENTJAIL_SOCKET=/tmp/agentjail-dev.sock dsh --profile dev
```

The unit tests are the fastest signal. They need no daemon and no browser:

```sh
npx vitest run tests/unit/client-face.test.ts     # transport and slot registration
npx vitest run tests/unit/client-section.test.tsx # the section, in jsdom
npx vitest run tests/unit/client-bundle.test.ts   # the built lib/client.js, as loaded
```

The browser half is tested without a browser: the section renders in jsdom, the
transport runs over a stubbed `fetch`, and the built bundle is evaluated in a
stand-in module table so a lost registration or an inlined React copy fails the
suite. The only stand-in is `@deepseek-ai/dsh-client-ui-primitives`, aliased in
`vitest.config.ts` because the real package ships CSS modules Node cannot import;
`tsc` still type-checks against the published declarations, so a props change
fails the build rather than passing silently.

[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) covers the full loop: linking the
checkout into a running Harness, running against a real policy engine, and what to
check when the section does not appear.

The test suite has three layers, and the integration layer is the one that
matters: it mounts the plugin on a real Cordis runtime with the real
`ToolsService` and native executor, registers real tools, and asserts that a
denied call's body never ran. Adapter tests talk to a real Unix socket served by
an in-process fake daemon. Unit tests cover the pure decision logic.

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md). The one rule worth stating here:
any change touching the enforcement path must explain why it cannot turn a deny
into an allow.

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for third-party attribution.
