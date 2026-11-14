# Settings panel and operational surface

The plugin records every decision. This document describes the three ways to read
that record: the Settings panel, for watching a running session; the read-only
HTTP routes that feed it, for `curl` and scripts; and the in-process `agentjail`
service, for scripting.

## The panel is a Settings section

The panel is not a page the plugin serves. It is a contribution to the Harness
Settings dialog, registered through the client slot system — the same mechanism
every built-in settings page uses.

The package declares a browser half in `package.json`:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
}
```

The Harness client module system serves `./client` — a lazy-CJS factory built from
`src/client/` by `scripts/build-client.mjs` — and the factory registers one entry:

```ts
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    {
      name: 'settings.section',
      id: 'agentjail',
      order: 100,
      label: 'AgentJail',
      inject: () => face,
    },
    AgentJailSection,
  ),
)
```

Three details matter and are worth stating explicitly:

- **`inject`, not a direct register.** `slots.inject` waits until the settings
  domain has declared `settings.section`, so load order between this plugin and
  the settings shell does not matter.
- **The disposer is an effect.** The registration is wrapped in `ctx.effect`, so
  unloading the plugin removes the section. No Harness file is edited, and the
  plugin leaves no residue behind.
- **The owner props come from the shell.** The settings shell owns modal
  visibility and navigation; the component receives `close` from it, and its own
  data through the inject face. Nothing is read out of a global registry.

`order: 100` places the section after General; the label is a plain string, since
the panel's own copy is English. `settings.section` is a `list` slot at `root`
scope whose owner props are just `{ close }`, so the component adds nothing to
that contract and the shell keeps ownership of modal visibility and navigation.

The shapes above are the ones the Harness documents:

- [`reference/subsystems/client-modules`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
  — the `dsh.client` declaration and the lazy-CJS factory the bundle must be.
- [`reference/subsystems/slots`](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)
  — `ctx.slots.inject` / `ctx.slots.register`, and why the registration is an
  effect.
- [`reference/cookbook/adding-a-settings-card`](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)
  — where a browser half hangs, and the rule that only the row whose specifier is
  the bare package name receives one.

## Why it is read-only

A reporting surface is a target. If the panel could edit a policy, clear a denial,
or change `failureAction`, then reaching it would be equivalent to disabling the
gate, and the gate would be only as strong as the panel's authentication.

So it cannot do any of those things. Every route answers `GET`. There is no write
path, no form, and no mutation. The panel is a view of state that the enforcement
path already produced, and nothing in it can widen what a tool call is allowed to
do.

Two consequences worth stating plainly:

- An unauthenticated reader sees the same data as you do. Bind the web server to
  loopback (the default for `dsh web`) and treat the port as sensitive. The
  audit record is already redacted by `audit.redactSensitiveData`, so argument
  values are truncated rather than exposed.
- Reading the panel is not a privileged operation, so there is no reason to put it
  behind the approval flow.

## HTTP routes

Registered only when a Harness web server is composed (`dsh web`). With the CLI
or the desktop app, no routes are registered and nothing is served. The panel is
still contributed; it just has no data source and shows the error from its first
failed read.

The base path defaults to `/agentjail` and is configurable with `ui.basePath`. The
Host advertises it to the browser half as a `global` index-injection row, so the
panel follows a moved base path without a rebuild.

### `GET /agentjail`

Content-negotiated. `?format=json` returns the summary JSON; anything else returns
fixed-width text, so `curl localhost:3080/agentjail` is readable with no flags. A
browser navigating here gets the text too — the rich view lives in Settings, not
on a route.

| Query          | Effect                  |
| -------------- | ----------------------- |
| `?format=text` | Force plain text.       |
| `?format=json` | Force the summary JSON. |

### `GET /agentjail/api/summary`

The whole panel as JSON: health, supervision, counts by verdict, the current
approvals, recent alerts, and the most recent audit records.

### `GET /agentjail/api/decisions`

The audit records, newest first.

| Query           | Default          | Effect                          |
| --------------- | ---------------- | ------------------------------- |
| `?limit=`       | `ui.recordLimit` | Clamped into `1..1000`.         |
| `?verdict=deny` | none             | Only records with that verdict. |

### `GET /agentjail/api/health`

The engine and supervision state, plus the posture the plugin is applying.

```json
{
  "state": "healthy",
  "socketPath": "/home/you/.agentjail/daemon.sock",
  "connected": true,
  "consecutiveFailures": 0,
  "supervision": "external",
  "enforcement": "enforce",
  "failureAction": "deny"
}
```

`supervision` is one of `external` (a daemon the plugin did not start),
`started` (one it did), `exited`, `unavailable` (no binary found), or `disabled`
(`daemon.supervise: false`).

### Response headers

Every response carries `cache-control: no-store`,
`x-content-type-options: nosniff`, and `referrer-policy: no-referrer`. A decision
record is not something a proxy or a browser cache should hold.

## How the panel refreshes

The panel polls the read-only routes every `ui.refreshMs` milliseconds while it is
mounted, and stops when the section is unmounted. `0` disables the timer, leaving
the Refresh button. A failed read renders an error banner and keeps the last good
data on screen, so a daemon restart does not blank the view.

The Host also advertises `ui.refreshMs` in the same injection row, so a profile
that changes the interval changes the panel's polling without a rebuild.

## What the panel shows

- **Engine** — whether the daemon is answering.
- **Supervision** — what the plugin is relying on for policy.
- **Decisions, Denied, Asked, Deny rate** — the sliding window from
  `governance.statsWindowMs`.
- **Approvals** — outstanding grants.
- **Recent decisions** — up to 200 rows: sequence, time, tool, verdict, rule, and
  reason.
- **Outstanding approvals** — tool, session, expiry, and whether the grant is
  one-time or session-scoped.
- **Alerts** — the deny, ask, and deny-rate alerts raised since load.

## The `agentjail` service

The same data is available in-process, so a plugin or a test can read it without
HTTP.

```ts
ctx.agentjail.health() // link state, last error, daemon version
ctx.agentjail.probeHealth() // probe now and return the refreshed snapshot
ctx.agentjail.stats() // sliding-window risk statistics
ctx.agentjail.queryAudit({ verdict: 'deny', limit: 50 })
ctx.agentjail.listGrants() // outstanding approvals
ctx.agentjail.revokeGrant(id) // revoke one approval
ctx.agentjail.revokeSession(sessionId) // revoke a session's approvals
ctx.agentjail.grantSession({ toolName, sessionId, digest }) // authorize a repeat call
ctx.agentjail.reportText() // a readable security report
ctx.agentjail.dashboard() // the dashboard payload, JSON-ready
ctx.agentjail.dashboardText() // the dashboard as fixed-width text
ctx.agentjail.supervision() // the current supervision state
ctx.agentjail.ensureDaemon() // start a daemon if none is answering
ctx.agentjail.alerts() // alerts raised since load
ctx.agentjail.reloadPolicy() // ask the daemon to reload, then drop cached verdicts
ctx.agentjail.invalidateCache() // drop cached verdicts only
```

`revokeGrant` and `revokeSession` remove an authorization. `grantSession` is the
only call that adds one, and it is deliberate: the approval answerer issues
one-time grants, so a session grant exists only because an operator asked for it.

## Configuring the surface

```yaml
ui:
  enabled: true # register the data routes when a web server is composed
  basePath: /agentjail
  refreshMs: 5000 # 0 disables the panel's polling
  recordLimit: 200 # rows the JSON summary carries
```

`ui.enabled: false` registers no routes. The panel is still contributed by the
browser half and will show a read error; uninstall the plugin, or omit its client
module, to remove the section itself. The audit trail is unaffected either way —
it is written by the enforcement path, not by the panel.

## Cost

The panel reads from in-memory structures the plugin already maintains: the
metrics window, the bounded grant store, and the audit query. A request does no
daemon round trip and holds no lock across a tool call. Serving a page is a
read of already-computed state.

The one bound worth knowing is `ui.recordLimit`: the JSON summary and the panel
carry at most that many records. `/agentjail/api/decisions` accepts a higher
`limit` up to 1000 for a one-off query.
