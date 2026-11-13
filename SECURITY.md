# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private advisory form:

<https://github.com/axetroy/dsh-plugin-agentjail/security/advisories/new>

Do not open a public issue, and do not include exploit details in a discussion.

Include what you can of the following. Partial reports are still useful.

- The plugin version (`npm ls dsh-plugin-agentjail`).
- The DeepSeek Harness version and the AgentJail version.
- The configuration row, with any secrets removed.
- What an attacker can do that they should not be able to do.
- Whether the issue requires a specific policy, or reproduces with the shipped
  templates.

**Do not include real credentials or unredacted audit records.** The plugin
redacts by default; if you must share a record, redact it yourself first.

## What to expect

This is a small project maintained in the open, so the honest answer is a
best-effort timeline rather than a service-level commitment.

| Stage                  | Target                        |
| ---------------------- | ----------------------------- |
| Acknowledgement        | 3 working days                |
| Initial assessment     | 10 working days               |
| Fix or mitigation plan | 30 days for a confirmed issue |

You will be credited in the advisory unless you ask not to be.

## Scope

In scope:

- A tool call that should be denied but is executed, or vice versa.
- A path that turns an unreachable, timing-out, or malformed engine response
  into an allow.
- A grant that authorizes a call it should not, including one that survives
  beyond its intended scope or is reused after consumption.
- A way to make the audit trail misrepresent a decision, or to suppress a record.
- A credential written to a sink the plugin controls in a form the redactor
  should have caught.
- A configuration that silently weakens enforcement without the operator asking
  for it.

Out of scope:

- **What an allowed tool then does.** An allowed shell command can spawn
  processes and open sockets. That is a documented limit, not a vulnerability.
  See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
- **Bugs in AgentJail or OPA.** Report those upstream. If the plugin mishandles a
  valid response, that part is in scope here.
- **Deliberate misconfiguration.** `failureAction: allow`, a broad `exemptTools`
  entry, and `enforcement: monitor` are documented settings with documented
  consequences.
- **A malicious policy.** The policy is trusted input by design.
- **Denial of service by stopping the daemon.** Fail-closed is the intended
  behavior.

## Security-relevant design decisions

These are choices a reader might otherwise mistake for defects.

- **The failure action defaults to deny.** An unreachable engine blocks calls.
  Availability loses to an ungoverned agent.
- **The gate never throws.** A thrown listener surfaces as a generic tool
  failure, which is indistinguishable from a policy denial and useless as a
  signal, so every failure path resolves a verdict instead.
- **`ask` fails closed with no approval service.** An unanswered question is not
  a yes.
- **Grants bind session, tool, and argument digest, and are consumed on use.**
  Approving one command does not approve a variant.
- **The audit trail is written with redacted values.** `sanitizer.ts` runs before
  any sink.
- **A failed audit write does not change a verdict.** Logging must not become a
  bypass, in either direction.

## Supported versions

The plugin is pre-1.0. Fixes land on the latest published minor version, and
`0.x` releases may include a breaking change. Pin an exact version if you need
stability across upgrades.
