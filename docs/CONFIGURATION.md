# Configuration

Configuration lives in the `agentjail` row of a Cordis patch layer. The shipped
[`cordis.patch.yml`](../cordis.patch.yml) is the default, and it is the safe
starting point.

A patch **replaces** a row's whole `config` value rather than merging into it, so
a user layer that overrides one key must restate every key it keeps.

```yaml
- insert:
    - id: agentjail
      name: dsh-plugin-agentjail
      config:
        enforcement: enforce
        socketPath: ''
        timeoutMs: 2000
        failureAction: deny
        defaultAction: deny
        askAction: ask
        askFallback: native
        healthCheckOnLoad: true
        healthCheckIntervalMs: 30000
        monotonicGuard: true
        exemptTools: []
        exemptToolPrefixes: []
        cache:
          enabled: true
          maxEntries: 1024
          ttlMs: 5000
        audit:
          enabled: true
          storage: file
          filePath: ''
          maxFileBytes: 8388608
          maxRotatedFiles: 5
          redactSensitiveData: true
          maxValueChars: 256
        approval:
          grantsEnabled: true
          sessionGrantTtlMs: 3600000
          maxGrants: 512
        governance:
          alertsEnabled: true
          denyRateAlertThreshold: 0.5
          denyRateAlertMinSamples: 20
          statsWindowMs: 300000
          includePolicyDigest: true
```

## Enforcement

### `enforcement`

`enforce` | `monitor`. Default `enforce`.

- `enforce` applies verdicts. A deny blocks the call.
- `monitor` records every verdict and blocks nothing. It returns `allow` for
  every call and logs what it would have done.

Use `monitor` to size a policy before trusting it. It is not a security mode: an
agent in monitor mode is unconstrained. It is also not a place to stay - the
audit trail from a monitor run is the input to fixing the policy, not a
substitute for enforcing it.

### `failureAction`

`allow` | `deny` | `ask`. Default `deny`.

The verdict when no trusted answer is available: the daemon is unreachable, the
request timed out, the response was malformed, or the caller aborted.

Do not set this to `allow`. It converts every transport problem into an
unrestricted agent. It exists for a deliberate, temporary debugging session
where you are watching the process.

### `defaultAction`

`allow` | `deny` | `ask`. Default `deny`.

The verdict when the engine returns a decision that names no rule and no action.

Do not set this to `allow` unless your policy is written to be exhaustive, which
is hard to prove and easy to break with an edit.

### `askAction`

`ask` | `deny`. Default `ask`.

How an engine `ask` is mapped. A deployment with no way to answer a prompt - a
headless CI job, for example - sets this to `deny` so asks fail closed at the
mapping step rather than depending on the approval chain.

### `askFallback`

`native` | `deny`. Default `native`.

- `native` surfaces the question through the Harness approval service.
- `deny` resolves it as a denial without prompting.

## Connection

### `socketPath`

Default `''`. Empty resolves `$AGENTJAIL_SOCKET`, then
`$HOME/.agentjail/daemon.sock`.

### `timeoutMs`

Default `2000`. The per-request budget. Past it, the failure action applies.

The design targets P95 under 50 ms for a healthy local daemon. A timeout much
above that is a ceiling, not an expectation; a timeout below it will produce
spurious failures on a loaded machine.

### `healthCheckOnLoad`, `healthCheckIntervalMs`

Defaults `true` and `30000`. The plugin probes the daemon once at load and then
on an interval. `0` disables the interval.

A failed probe never changes a verdict. It reports health, and health is
diagnostic: the failure action already covers an unusable engine.

## Overrides and exemptions

### `exemptTools`, `exemptToolPrefixes`

Default `[]`.

A tool named here bypasses the engine entirely and is recorded as
`source: 'exempt'`. This is the only path that skips evaluation.

Keep both empty. Every entry is a tool that runs unexamined, and the audit record
that would tell you it misbehaved says only that it was exempt. If a tool must be
exempt, prefer `exemptToolPrefixes` with the narrowest prefix that works, and
write down why somewhere a reviewer will find it.

### `overrides`

Per-agent, per-session, and per-tool verdicts applied before the engine:

```yaml
overrides:
  agents:
    ci-runner: { action: allow, reason: 'the CI agent runs only reviewed jobs' }
  sessions:
    session_9c1e: { action: deny }
  tools:
    webfetch: { action: deny, reason: 'egress is disabled for this deployment' }
```

Precedence is agent, then session, then tool. Overrides are a blunt instrument
that sits in front of the engine, so they are invisible to the audit trail's
`ruleId`; the record shows `source: 'override'` instead. Prefer a Rego rule when
the condition is expressible there.

## Verdict cache

### `cache.enabled`, `cache.maxEntries`, `cache.ttlMs`

Defaults `true`, `1024`, `5000`.

The cache key binds the tool name, session, working directory, and argument
digest, so a verdict granted for one argument set is never reused for another.
Entries expire on the TTL and are evicted oldest-first past the cap.

A short TTL bounds how long a verdict can outlive a policy change. Call
`ctx.agentjail.invalidateCache()` after a reload. Set `enabled: false` when you
would rather pay a round trip per call than reason about staleness.

## Audit

### `audit.enabled`, `audit.storage`

Defaults `true`, `file`.

- `file` appends JSON Lines to `filePath`.
- `memory` keeps only the ring buffer, for a container with no writable volume.
- `none` records nothing.

`none` is a real loss. The audit trail is the evidence that answers "what did the
agent do", and it is the only thing that makes a monitor-mode trial useful.

### `audit.filePath`

Default `''`. Empty resolves `$AGENTJAIL_DSH_AUDIT_PATH`, then
`$HOME/.agentjail/dsh-audit.jsonl`.

### `audit.maxFileBytes`, `audit.maxRotatedFiles`

Defaults `8388608` (8 MiB) and `5`. The file rotates when it exceeds the size
limit, and the oldest rotation is removed past the count. Total on-disk ceiling
is `maxFileBytes * (maxRotatedFiles + 1)`.

### `audit.redactSensitiveData`

Default `true`.

Redaction replaces values whose key looks sensitive - `password`, `token`,
`secret`, `api_key`, `authorization`, and similar - and rewrites inline
credentials inside command strings, such as a bearer header or `PASSWORD=...`.

Leave it on. The audit file is often the most widely readable artifact this
plugin produces, and tool arguments routinely contain credentials.

### `audit.maxValueChars`

Default `256`. Argument values longer than this are truncated. A tool call can
carry a megabyte of file content; storing all of it turns the audit trail into a
data copy of the workspace.

## Approval

### `approval.grantsEnabled`

Default `true`.

Whether an approved call is remembered as a grant. With it off, every matching
call is re-evaluated and re-prompted, which is safe but noisy.

### `approval.sessionGrantTtlMs`

Default `3600000` (one hour). The lifetime of a session grant. The approval
answerer issues one-time grants; the TTL applies to session grants issued through
the grant API.

### `approval.maxGrants`

Default `512`. The grant store evicts oldest-first past this size.

## Governance

### `governance.alertsEnabled`

Default `true`. Whether the plugin emits structured alerts for denials, asks,
engine-unavailable events, and deny-rate spikes.

### `governance.denyRateAlertThreshold`, `denyRateAlertMinSamples`

Defaults `0.5` and `20`. An alert fires when the window holds at least
`denyRateAlertMinSamples` decisions and the deny rate exceeds the threshold. The
sample floor exists so a single denial in a quiet window does not page anyone.

### `governance.statsWindowMs`

Default `300000` (five minutes). The width of the sliding window the statistics
and the deny-rate alert are computed over.

### `governance.includePolicyDigest`

Default `true`. Whether the security report includes a digest of the effective
enforcement settings, so a report can be tied to the configuration that produced
it.

## Environment variables

| Variable                   | Effect                                           |
| -------------------------- | ------------------------------------------------ |
| `AGENTJAIL_SOCKET`         | Daemon socket path, when `socketPath` is empty.  |
| `AGENTJAIL_DSH_AUDIT_PATH` | Audit file path, when `audit.filePath` is empty. |
