# Architecture

This document describes how the plugin is put together and why each boundary is
where it is. It assumes you have read the [README](../README.md).

## The shape of the problem

DeepSeek Harness runs an agent, and an agent acts by calling tools. The registry
in `@deepseek-ai/dsh-tools` exposes a pipeline around each call, and it emits
`tools/pre-execute` before the tool body runs. A listener on that event returns
one of `allow`, `deny`, `ask`, or `cancel`.

Everything this plugin does fits into answering that one event correctly.

## Layering

```
+--------------------------------------------------------------+
| DeepSeek Harness                                             |
|   agent -> ctx.tools.call -> tools/pre-execute -> tool body  |
+---------------------------+----------------------------------+
                            | PreToolDecision
+---------------------------v----------------------------------+
| dsh-plugin-agentjail                                         |
|                                                              |
|  hooks/pre-tool-use      the gate; the only enforcement point|
|  hooks/post-tool-use     records outcomes, sandbox denials   |
|  hooks/approval          turns an approved ask into a grant  |
|                                                              |
|  security/decision       resolves one call into one verdict  |
|  security/normalizer     Harness vocabulary -> AgentJail     |
|  security/grants         approvals bound to a call identity  |
|  security/policy         Rego templates                      |
|  security/sanitizer      redaction before any sink           |
|                                                              |
|  adapter/agentjail-client  cache, health, normalization      |
|  adapter/connection        one pooled Unix socket            |
|  adapter/protocol          frame encode/decode + validation  |
|                                                              |
|  audit/audit-log         one durable record per decision     |
|  governance/metrics      sliding-window risk statistics      |
|  governance/report       operator-facing report + digest     |
|  config/schema           the validated configuration         |
+---------------------------+----------------------------------+
                            | newline-delimited JSON over a Unix socket
+---------------------------v----------------------------------+
| AgentJail daemon -> OPA -> Rego policies                     |
+--------------------------------------------------------------+
```

Dependencies point downward. `security/decision.ts` knows about the client, the
grant store, and the config; it knows nothing about Cordis. The hooks know about
Cordis and the registry. That split is what lets the decision logic be tested
without a runtime and the runtime be tested without a daemon.

## The enforcement path, step by step

1. The registry emits `tools/pre-execute` with a `ToolExecution`.
2. `hooks/pre-tool-use.ts` reads the call identity - session, agent, working
   directory - and computes an argument digest.
3. `security/decision.ts` resolves a verdict in a fixed order:
   1. **Exemption.** An explicit `exemptTools` or `exemptToolPrefixes` match
      allows the call and records `source: 'exempt'`.
   2. **Override.** The most specific configured override - agent, then session,
      then tool - decides, recording `source: 'override'`.
   3. **Grant.** A previously issued approval matching this exact session, tool,
      and argument digest allows the call and is consumed.
   4. **Engine.** The call is normalized into AgentJail's vocabulary and
      evaluated. `source` is `engine`, or `cache` when a cached verdict was used.
   5. **Default action.** Applies when the engine matched no rule, which it reports
      as an `allow` carrying no `rule_id`. Its default is `deny`.
   6. **Failure action.** Applies when no trusted answer exists at all - an
      unreachable daemon, a timeout, a malformed frame, a caller abort. Its
      default is `deny`.
4. The verdict is recorded to the audit log and the metrics collector.
5. The verdict is mapped onto `PreToolDecision` and returned.

The order is not configurable. That is deliberate: step 6 is the only place a
transport failure can land, so "the daemon is down" can never become an allow.

## Why the failure action is a separate concept

It would be simpler to reuse `defaultAction` for failures. It is also wrong. A
default action expresses "no rule matched"; a failure action expresses "I do not
know". They warrant different values, different audit records, and different
operator responses. A trail full of `source: 'failure-action'` means the daemon
is down; a trail full of `source: 'default'` means the policy has a gap.

## The monotonic guard

`tools/pre-execute` is an event, so any listener can add one. A later listener
could, in principle, return `allow` for a call this plugin denied. The plugin
therefore also registers a `ctx.tools.guard` when `monotonicGuard` is enabled. A
guard has no allow result: once it returns a reason, the call is closed. The gate
remembers the reason it resolved for each in-flight call in a `WeakMap` keyed by
the execution object, and the guard re-asserts it.

Monitor mode does not arm the guard, because monitor mode must not block
anything, and an armed guard would defeat it.

## The gate never throws

A listener that throws produces an error result, which the model reads as an
ordinary tool failure. That is indistinguishable from a policy denial in the
transcript, so it destroys the signal the audit trail exists to provide. Every
failure path inside the gate instead resolves a verdict through the failure
action.

## Transport

The daemon speaks newline-delimited JSON over a Unix domain socket. One
connection is pooled and requests are serialized: the daemon replies in order on
one connection, so one in-flight request at a time keeps responses matched to
requests without a correlation table. A failed connection is discarded and
rebuilt on demand, with bounded exponential backoff.

`adapter/protocol.ts` validates every response frame before the rest of the
plugin sees it. An unrecognized action is a protocol error, not an allow.

## Approvals

When the verdict is `ask`, the registry asks `ctx.approval`, which walks the
answerer chain. This plugin registers one answerer, and it delegates with
`next()` first. That ordering matters:

- An operator's explicit rejection is never overridden by a remembered approval,
  because the answerer only acts on an `allowed-once` outcome.
- A headless deployment with no answerer still fails closed through the chain's
  `unavailable` outcome.

On `allowed-once`, the answerer issues a grant bound to the session, tool, and
argument digest, and records it. The next identical call short-circuits at the
grant stage instead of reaching the daemon - which is the point, because
re-prompting for the same command trains operators to approve without reading.

## Audit and governance

`audit/audit-log.ts` maintains an in-memory ring buffer and, when configured, an
append-only JSON Lines file with size-based rotation. Both receive already
redacted values; `security/sanitizer.ts` runs before any sink.

`governance/metrics.ts` keeps a sliding window of samples and raises a deny-rate
alert when the window is both large enough and above threshold. A failed audit
write is reported but never changes a verdict - logging is not allowed to become
a bypass.

## What the architecture deliberately does not do

- **No Rego evaluation in the plugin.** One engine, one audit trail. If the
  plugin re-implemented policy, the two would drift.
- **No core Harness modification.** Integration is entirely through the
  documented plugin API.
- **No interpretation of shell command strings beyond normalization.** The
  plugin forwards `command` to the engine; patterns live in Rego.
