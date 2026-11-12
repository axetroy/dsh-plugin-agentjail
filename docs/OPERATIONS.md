# Operations

This document covers running the plugin: verifying it is working, reading its
output, and responding when something is wrong.

## Verify the install

```sh
# The daemon is up and the socket exists.
ls -l "$HOME/.agentjail/daemon.sock"

# The bundle layer is in the composed config.
dsh --profile secure --dump-config | grep -A2 'dsh-plugin-agentjail'
```

At load, the plugin logs one line naming the mode, the socket, and the two
fallback verdicts:

```
agentjail: mounted in enforce mode; socket=/home/u/.agentjail/daemon.sock failure=deny default=deny
```

If the daemon is unreachable at that moment, the next line says so, and every
protected call is denied until it appears:

```
agentjail: policy engine is unavailable at /home/u/.agentjail/daemon.sock; applying the configured failure action "deny"
```

That is the intended state, not a fault. An agent with no policy engine should
not be running tools.

## Reading health

```ts
ctx.agentjail.health()
// {
//   state: 'healthy' | 'degraded' | 'unavailable' | 'unknown',
//   socketPath: '/home/u/.agentjail/daemon.sock',
//   connected: true,
//   consecutiveFailures: 0,
//   lastSuccessAt: 1762901467512,
//   daemonVersion: '1.2.0'
// }
```

`degraded` means requests have failed recently but the link has worked before.
`unavailable` means the failure count is high or the socket is gone. Probe on
demand with `ctx.agentjail.probeHealth()`.

A daemon version that changes under you is worth noticing: a policy engine
upgrade can change verdicts.

## Reading the audit trail

```ts
ctx.agentjail.queryAudit({ verdict: 'deny', limit: 50 })
ctx.agentjail.queryAudit({ sessionId: 'session_9c1e' })
ctx.agentjail.queryAudit({ since: Date.now() - 3_600_000 })
```

The `source` field is the first thing to read:

| `source`         | Meaning                                           | What to do                               |
| ---------------- | ------------------------------------------------- | ---------------------------------------- |
| `engine`         | The policy decided.                               | Read `ruleId` and `reason`.              |
| `cache`          | A recent identical call was decided the same way. | Nothing.                                 |
| `override`       | Configuration decided before the engine.          | Confirm the override is still intended.  |
| `exempt`         | The tool bypasses policy.                         | Confirm the exemption is still intended. |
| `grant`          | A prior approval authorized this call.            | Confirm `grantId` is expected.           |
| `default`        | No rule matched.                                  | A policy gap.                            |
| `failure-action` | No trusted answer was available.                  | The engine is down. Check health.        |

A trail that is mostly `failure-action` is an outage, not an agent behaving
badly. A trail with a rising `default` share is a policy drifting out of date.

## Statistics and alerting

```ts
ctx.agentjail.stats()
// { total, byVerdict, bySource, byTool, denyRate, askRate, offloadRate,
//   meanDurationMs, maxDurationMs, windowStart, windowEnd, sessions }
```

`offloadRate` is the share of decisions that never reached the engine - cache,
grant, override, or exemption. A high offload rate is good for latency and worth
understanding: it means policy is being decided somewhere other than the engine.

Two alerts matter operationally:

- **`deny-rate`** - the deny rate crossed the threshold with enough samples to be
  meaningful. A spike is either a policy change, a prompt-injection attempt, or
  an agent that has lost the thread. Read the denied calls before assuming which.
- **`engine-unavailable`** - the daemon stopped answering. Every protected call
  is being denied by the failure action.

Alerts reach `options.onAlert` when you pass one to `apply`, and are logged
otherwise. They are also retained for inspection:

```ts
ctx.agentjail.alerts()
```

## Reports

```ts
ctx.agentjail.reportText()
```

The report contains the windowed metrics, the engine health, the outstanding
grants, and - when `includePolicyDigest` is on - a digest of the effective
enforcement settings. The digest is what lets you attach a report to the
configuration that produced it.

## Log retention

The file sink rotates at `audit.maxFileBytes` and keeps
`audit.maxRotatedFiles` rotations, so the on-disk ceiling is
`maxFileBytes * (maxRotatedFiles + 1)` - 48 MiB with the defaults. Records are
newline-delimited JSON, so `jq` and any log pipeline can read them directly:

```sh
jq -r 'select(.verdict=="deny") | "\(.timestamp) \(.toolName) \(.ruleId // "-")"' \
  ~/.agentjail/dsh-audit.jsonl
```

The plugin does not delete anything older than the rotation window. If your
retention policy is longer, ship the file to a collector; if it is shorter,
`audit.storage: memory` keeps nothing on disk.

## Incident response

**An agent did something it should not have.** Query the trail for the session.
Find the record whose `toolName` and `arguments` match. Read `source`:

- `engine` with an `allow` - the policy permitted it. Fix the policy, not the
  plugin.
- `override` or `exempt` - configuration permitted it. Remove the override or
  exemption.
- `grant` - a human approved it. Check whether the approval was informed.
- `failure-action` with `failureAction: allow` - someone disabled fail-closed.
  This is the one case that is a configuration defect rather than a policy gap.
  Restore `deny` immediately.

**The daemon is down.** Every protected call is denied. Restart the daemon. The
agent will report blocked calls until it is back; that is the correct behavior,
not a bug to work around.

**Verdicts changed without a policy edit.** Check the daemon version in
`health()`. An engine upgrade can change evaluation. Then check the cache: a
verdict computed before a reload can be served for up to `cache.ttlMs`.

**Denials are too noisy to be actionable.** Switch to `enforcement: monitor`,
collect a window, and read `stats().byTool` and the denied records. Fix the
policy. Switch back to `enforce`. Do not leave monitor mode on.

## Sizing

The plugin adds one round trip per uncached call to a local socket. The design
target is P95 under 50 ms; measure it on your hardware with your policy, because
a policy with expensive Rego will not hit that.

Memory is bounded by three caps: the verdict cache (`cache.maxEntries`), the
grant store (`approval.maxGrants`), and the in-memory audit ring. All three evict
oldest-first.
