# Threat model

This document states what the plugin defends against, what it does not, and how
to reason about the gap. It is the honest half of the security story: the
[README](../README.md) lists guarantees, and this lists their limits.

## What the plugin is

An interception point in front of tool execution. It answers one question - may
this call, with these arguments, in this session, proceed - using a policy engine
that lives outside the agent's control. It is a control plane for tool calls.

## Assets

- The machine the agent runs on: its files, its credentials, its network
  position.
- The credentials reachable from that machine, including any the agent's own
  process holds.
- The integrity of the user's work: repositories, configuration, deployments.
- The audit trail itself, as evidence of what happened.

## Adversaries

1. **A prompt-injected agent.** Malicious content in a file, a web page, or a
   tool result instructs the agent to do something the user did not ask for.
   This is the primary threat, and the one the plugin is built for.
2. **An over-eager agent.** No adversary; the model simply chooses a destructive
   action while pursuing the stated goal.
3. **A compromised or malicious MCP server.** A tool the agent calls does
   something other than what it advertises.
4. **A local attacker with agent-level access.** Someone who can already run
   commands as the agent's user.

## What the plugin defends against

| Threat                                      | Defense                                                                  | Limits                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Prompt injection into a dangerous tool call | Policy denies the call before the tool body runs                         | Only calls whose danger is visible in the tool name and arguments. See below. |
| Credential exfiltration by reading files    | `no-credential-access` denies known credential paths                     | A path not on the list. A credential pasted into a file the agent may read.   |
| Destructive shell commands                  | `no-remote-execution` denies `rm -rf` outside cwd, `sudo`, pipe-to-shell | Shell is a language. A rule set cannot enumerate every way to delete a file.  |
| Egress to attacker infrastructure           | `restricted-egress` denies hosts outside the allowlist                   | Only `WebFetch`. A shell command can open a socket.                           |
| Unapproved MCP tools                        | `mcp-allowlist` denies unlisted servers                                  | Only calls that reach `tools/pre-execute`.                                    |
| Unauthorized mutations                      | `approve-mutations` asks a human                                         | A human who approves without reading.                                         |
| Silent misbehavior                          | One audit record per decision                                            | A call the plugin never saw.                                                  |

## What the plugin does not defend against

This section matters more than the previous one.

**Effects of an allowed process.** The plugin sees a tool call, not what the call
then does. An allowed shell command can spawn processes, open sockets, and write
files, none of which pass through `tools/pre-execute` again. Interception governs
what the agent _asks for_; it does not govern what an allowed program _does_.
AgentJail's OS sandbox and network tunnel exist for that layer, and this plugin
does not replace them.

**Tool-internal actions.** A tool body may do anything. An allowed MCP tool can
perform its own file or network operations internally. The plugin approved the
call, not the tool's implementation.

**Bypasses outside the interception point.** The plugin governs calls that reach
`tools/pre-execute`. Anything that executes without going through the registry -
a different entry point, a pre-existing process, the agent's own runtime - is
outside its view.

**A compromised plugin or daemon.** The plugin trusts the daemon's response and
the plugin's own code. An attacker who can modify either has the agent's
privileges.

**Argument-level obfuscation.** A policy matches on the arguments as written.
`rm -rf /` and `r''m -rf /` are different strings. The templates are written to
catch common forms, not to be a shell parser, and treating them as one would be a
mistake.

**Denial of service.** The plugin fails closed, so an attacker who can take the
daemon down can stop all tool use. That is a deliberate trade: availability is
worth less than an ungoverned agent.

**The approval human.** An operator who approves a prompt without reading it has
removed the control. Grants are narrow - one session, one tool, one argument
digest, consumed on use - so an approval cannot be widened, but it can still be
given carelessly.

## Trust boundaries

```
user --trusts--> policy author --writes--> Rego --evaluated by--> OPA
                     |
                     +--trusts--> the plugin's enforcement

agent --untrusted--> tool call --> plugin --> verdict

reader --untrusted--> panel data route --> already-redacted state
plugin --trusts--> agentjail binary --> started as a child process
```

The agent is untrusted. The policy is trusted: it is the thing that decides. The
plugin is trusted to enforce the policy faithfully, which is why the enforcement
path has its own tests and a review requirement.

Two boundaries were added after the first release, and neither is on the
enforcement path:

- **The Settings panel** reads state the enforcement path already produced. It has
  no write path, so a reader who reaches its data routes can learn what happened
  but cannot change what will happen. It is still a reader of session ids, tool
  names, and redacted arguments, so bind the web server to loopback and treat the
  port as sensitive.
- **The supervised daemon** is a child process the plugin starts from a binary it
  located. The binary is trusted to be AgentJail. A `PATH` entry an attacker can
  write is a way to substitute it, which is why `daemon.binary` is authoritative
  and why the managed download verifies a digest before installing anything.

## Defense in depth

The plugin is one layer. The design white paper names the others:

| Layer          | Responsibility                  | This plugin            |
| -------------- | ------------------------------- | ---------------------- |
| Harness hook   | Intercept the tool call         | Implements             |
| Policy engine  | Decide                          | Delegates to AgentJail |
| OS sandbox     | Constrain an allowed process    | Does not implement     |
| Network tunnel | Constrain egress from a process | Does not implement     |
| Audit          | Record what happened            | Implements             |

Deploy the sandbox and the tunnel alongside this plugin. A deployment that relies
on interception alone has a control plane and no data plane.

The managed download (`daemon.managedInstall`) is a supply-chain decision rather
than a defense layer. It verifies the release's published SHA-256, which catches a
corrupted or truncated archive and a manifest that does not list the asset. It
does not verify the release's `minisign` signature, so it does not defend against
a compromise of the release host. A deployment that treats that as in scope
should install AgentJail out of band and pin `daemon.binary`.

## Configuration mistakes that defeat the model

In rough order of severity:

1. `failureAction: allow` - every transport failure becomes an unrestricted
   agent.
2. `defaultAction: allow` with an incomplete policy - anything the policy does
   not mention is permitted.
3. A broad `exemptTools` entry - the tool is ungoverned, and the trail says only
   that it was exempt.
4. `audit.enabled: false` - no evidence, so no incident response and no monitor
   trial.
5. `enforcement: monitor` left on - nothing is enforced at all.
6. A permissive `override` that outranks the engine for a broad scope.
7. `daemon.binary` left empty on a machine where an untrusted directory precedes
   the real `agentjail` on `PATH` - the plugin starts whatever it finds first.
8. The web server bound to a non-loopback address - the panel's data routes are
   unauthenticated by construction and readable by anyone who reaches the port.

Each of these is a legitimate setting in a specific situation. None is a
legitimate default.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Do not open a public issue.
