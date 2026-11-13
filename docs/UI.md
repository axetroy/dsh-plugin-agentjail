# Dashboard and operational surface

The plugin records every decision. This document describes the two ways to read
that record: the HTTP dashboard, for watching a running session, and the
in-process `agentjail` service, for scripting.

## Why it is read-only

A reporting surface is a target. If the dashboard could edit a policy, clear a
denial, or change `failureAction`, then reaching it would be equivalent to
disabling the gate, and the gate would be only as strong as the dashboard's
authentication.

So it cannot do any of those things. Every route answers `GET`. There is no write
path, no form, and no mutation. The dashboard is a view of state that the
enforcement path already produced, and nothing in it can widen what a tool call is
allowed to do.

Two consequences worth stating plainly:

- An unauthenticated reader sees the same data as you do. Bind the web server to
  loopback (the default for `dsh web`) and treat the port as sensitive. The
  audit record is already redacted by `audit.redactSensitiveData`, so argument
  values are truncated rather than exposed.
- Reading the dashboard is not a privileged operation, so there is no reason to
  put it behind the approval flow.

## HTTP routes

Registered only when a Harness web server is composed (`dsh web`). With the CLI
or the desktop app, no routes are registered and nothing is served.

The base path defaults to `/agentjail` and is configurable with `ui.basePath`.

### `GET /agentjail`

Content-negotiated. A browser receives a self-contained HTML page. Anything else
receives fixed-width text, so `curl localhost:3080/agentjail` is readable with no
flags.

| Query          | Effect                  |
| -------------- | ----------------------- |
| `?format=html` | Force HTML.             |
| `?format=text` | Force plain text.       |
| `?format=json` | Force the summary JSON. |

The HTML page is one document: no external stylesheet, no script tag with a
`src`, no framework, and no inline event handlers. It refreshes itself every
`ui.refreshMs` milliseconds; set that to `0` to disable the refresh.

### `GET /agentjail/api/summary`

The whole dashboard as JSON: health, supervision, counts by verdict, the current
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

## What the page shows

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
  enabled: true # register routes when a web server is composed
  basePath: /agentjail
  refreshMs: 5000 # 0 disables the page's self-refresh
  recordLimit: 200 # rows the JSON summary carries
```

`ui.enabled: false` registers nothing. The audit trail is unaffected — it is
written by the enforcement path, not by the dashboard.

## Cost

The dashboard reads from in-memory structures the plugin already maintains: the
metrics window, the bounded grant store, and the audit query. A request does no
daemon round trip and holds no lock across a tool call. Serving a page is a
read of already-computed state.

The one bound worth knowing is `ui.recordLimit`: the JSON summary and the page
carry at most that many records. `/agentjail/api/decisions` accepts a higher
`limit` up to 1000 for a one-off query.
