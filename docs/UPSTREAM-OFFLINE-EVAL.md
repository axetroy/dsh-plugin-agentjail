# Upstream request: an offline, fail-closed evaluation entry point

This document records why this plugin runs the AgentJail daemon instead of
evaluating policy in a short-lived child process, and holds the issue text to
send upstream when asking for a different entry point.

## What we established by inspecting v1.8.2

The facts below come from the pinned build in `vendor.lock.json`
(`v1.8.2`, `agentjail-v1.8.2-linux-amd64.tar.gz`, sha256 `fc78b787…`). They were
established by running the binary, not by reading upstream source.

1. A release archive contains two executables: `agentjail` (41 MB) and
   `agentjail-hook` (6.7 MB).
2. The policy engine (OPA/Rego) is compiled into `agentjail` only.
   `agentjail-hook` carries no engine; it is a forwarding layer.
3. `agentjail-hook` speaks newline-delimited JSON on stdin/stdout, and is
   single-shot: one request in, one response out, then it exits.
4. When `agentjail-hook` cannot reach the daemon socket it **allows** the call.
   The binary states this in its own embedded text: "agentjail-hook FAILS OPEN:
   if it cannot reach the daemon socket it ALLOWS the call (and prints a stderr
   marker). A prompt-injected or adversarial agent can abuse this by killing the
   daemon and slipping a command through the fail-open window".
5. `agentjail try --json` does read a JSONL stream on stdin and write JSONL on
   stdout, but it still requires a reachable daemon. With no daemon it emits
   `{"action":"error","error":"daemon not reachable …"}`.
6. `agentjail daemon` listens on a Unix domain socket. There is no stdio
   transport; `--socket stdio` is not a mode.
7. The only daemonless path is the `hook-fallback.json` sidecar, and it keeps
   three self-protection rules (`file_policy/agentjail_self`,
   `file_policy/agentjail_secrets`, `command_policy/no-policy-mutation`) while
   every other rule is off. It still answers `allow` for unmatched input, and
   the CLI reports the session as degraded: "running at REDUCED protection
   (degraded). Critical self-protection rules still enforced; other policy is
   OFF".

Taken together: the engine is only reachable through the daemon, and every
daemonless path either fails open or enforces a small fixed subset.

## Why this plugin therefore supervises a daemon

The plugin is a security control, and `DESIGN.md` section 5.2 requires a
fail-closed posture when the engine is unavailable. Building on
`agentjail-hook` would invert that posture: killing the daemon would turn
enforcement into allow, which is exactly the attack the upstream comment
describes. Restarting a CLI process per tool call was also ruled out by
`DESIGN.md` (it re-compiles the Rego bundle and re-reads the policy overlay on
every call, against the P95 < 50 ms target).

So the plugin starts the daemon when none is answering, and only stops a daemon
it started itself.

## The issue to send upstream

Title:

> Request: an offline, fail-closed policy evaluation entry point

Body:

> **Context.** I maintain a third-party integration (a security plugin for an
> agent harness) that calls AgentJail for a policy verdict before each tool
> call. Today I supervise `agentjail daemon` and speak the newline-delimited
> JSON socket protocol, which works well.
>
> **Request.** Would you consider a first-class, short-lived evaluation entry
> point that needs no daemon and fails **closed** when it cannot evaluate?
> Something shaped like `agentjail eval --stdin` (or a documented
> `--no-daemon` mode on `try`): read one hook-format request per line on stdin,
> write one verdict per line on stdout, compile the bundled policy in-process,
> and return `deny` rather than `allow` if the policy cannot be loaded.
>
> **Why not the existing paths.** `agentjail-hook` is the obvious candidate but
> it fails open when the socket is unreachable, and its own embedded comment
> notes that a prompt-injected agent can kill the daemon and slip a command
> through that window. The `hook-fallback.json` sidecar degrades to three
> self-protection rules and also allows unmatched input. Neither is a safe
> foundation for a control whose contract is fail-closed, and per-call CLI
> restarts would recompile the Rego bundle on every call.
>
> **Why it matters for integrations.** An embeddable, fail-closed evaluator
> would let an integration avoid managing a long-lived process and its socket
> lifecycle entirely, which is simpler and less surprising for users. It would
> also make the "no daemon running" failure mode explicit and safe instead of
> degraded-and-allow.
>
> **Non-goal.** This is not a request to change the daemon model for the CLI's
> own hooks; it is an additional entry point for embedders.

If upstream declines, the plugin keeps supervising the daemon. Record the
outcome here either way so the decision is not re-litigated from scratch.
