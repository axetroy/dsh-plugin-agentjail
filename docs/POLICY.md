# Policy

The plugin does not evaluate policy. It normalizes a tool call into AgentJail's
vocabulary, sends it to the daemon, and enforces the answer. Rules are Rego,
evaluated by AgentJail's OPA engine.

This document covers the translation, the templates that ship with the plugin,
and how to write a rule that fits.

## Normalization

AgentJail speaks the Claude Code hook vocabulary. Harness names the same
capabilities differently. `security/normalizer.ts` is the single translation
point.

| Harness tool            | AgentJail `tool_name`   | Argument mapping                                  |
| ----------------------- | ----------------------- | ------------------------------------------------- |
| `bash`                  | `Bash`                  | `command`                                         |
| `read`                  | `Read`                  | `file_path`                                       |
| `write`                 | `Write`                 | `file_path`, `content`                            |
| `edit`                  | `Edit`                  | `file_path`, `old_string`, `new_string`           |
| `webfetch`              | `WebFetch`              | `url`                                             |
| `websearch`             | `WebSearch`             | `query`                                           |
| `skill`                 | `Skill`                 | `name`                                            |
| `mcp__<server>__<tool>` | `mcp__<server>__<tool>` | passed through, `mcp_server` and `mcp_tool` added |
| anything else           | `Other`                 | passed through                                    |

The request frame carries `hook_event`, `tool_name`, `tool_input`, `session_id`,
`agent_id`, and `cwd`. Rego reads `input.tool_name`, `input.tool_input.*`,
`input.cwd`, and so on.

Normalization is pure and total, so a policy author can rely on the mapping
without a daemon, and the mapping itself is unit-tested.

## The decision contract

The daemon reads one document: `data.agentjail.dsh.decision`. It has this shape:

```json
{ "action": "deny", "rule_id": "no-remote-execution/destructive-delete", "reason": "..." }
```

`action` is `allow`, `deny`, or `ask`. `rule_id` and `reason` are reported to the
model and written to the audit record, so both should be readable by a person who
did not write the rule.

A decision with no matching rule falls to the plugin's `defaultAction`. A
transport failure falls to `failureAction`. Neither is the engine's decision to
make, which is why the engine never sees them.

## Shipped templates

A template is a named rule set. Select them with the
`policyContext.attributes.templates` list and render them with
`ctx.agentjail.writePolicyTemplates()`, or render them directly:

```sh
node -e "
  const { resolveTemplates, writeTemplateBundle } = await import('dsh-plugin-agentjail/policy')
  await writeTemplateBundle('/etc/agentjail/policies', resolveTemplates(['read-only', 'no-credential-access']))
"
```

| Template               | Kind     | Rules                                                                                                                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`            | baseline | deny `Write`, `Edit`, and `Bash`; reads pass                                                                                                                  |
| `no-credential-access` | additive | deny reads and writes of `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.env`, `.npmrc`, `.pypirc`, `id_rsa` and friends, and `*.pem`/`*.key`/`*.p12`/`*.pfx` |
| `no-remote-execution`  | additive | deny `rm -rf` outside the working directory, `curl ...                                                                                                        | sh`, and `sudo` |
| `restricted-egress`    | additive | deny `WebFetch` to hosts outside a small allowlist                                                                                                            |
| `approve-mutations`    | additive | ask before `Write` and `Edit`                                                                                                                                 |
| `mcp-allowlist`        | additive | deny MCP tools whose server is not on the list                                                                                                                |

The checked-in [`policy/`](../policy) directory is the rendered bundle for all
six. A test regenerates it and fails if the two drift.

### How the templates compose

Each template renders into its own Rego package under
`agentjail.dsh.templates.<name>`, and a generated entrypoint
(`99-decision.rego`) imports every package, unions their rules, and resolves one
verdict. Two templates that both contributed a `deny_rules` set would fail to
load in a single package - OPA treats that as a redeclaration - which is exactly
why the entrypoint exists.

Resolution order is fixed and cannot be reordered by a template: a matching deny
wins over a matching ask, and both win over the default allow. When several rules
of the same kind match, the lexicographically smallest rule id is reported, so
the verdict is deterministic rather than dependent on set iteration order.

This is why `approve-mutations` cannot be used to permit something
`no-credential-access` denies: asking is weaker than denying, by construction.

## Writing a rule

A rule is an id, a kind, a reason, and a Rego body.

```ts
import { renderTemplateModule, renderEntrypoint } from 'dsh-plugin-agentjail/policy'

const template = {
  name: 'no-prod-database',
  description: 'Deny shell commands that touch the production database.',
  kind: 'additive' as const,
  rules: [
    {
      id: 'prod-db',
      kind: 'deny' as const,
      reason: 'the production database is off limits to agents',
      body: `input.tool_name == "Bash"
command := input.tool_input.command
contains(command, "prod-db.internal")`,
    },
  ],
}
```

Two rules of thumb:

- **Deny on the specific thing, not on the class of thing.** A rule that denies
  every `Bash` call is a rule someone will ask to have exempted. A rule that
  denies commands naming the production database survives review.
- **Put the reason in the rule, and make it explain the consequence.** The reason
  reaches the model, and a model that understands _why_ it was blocked chooses a
  different approach instead of retrying the same call with different quoting.

### Checking your rules

The generated Rego is validated against a real OPA binary when one is on `PATH`:

```sh
opa check policy/
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' \
  | opa eval -d policy -I 'data.agentjail.dsh.decision'
```

The test suite runs the same checks, and skips them with a clear marker when OPA
is absent. Install OPA and set `OPA_BIN` if it is not on `PATH`.

## Policy reloads

The daemon owns policy loading. After it reloads, the plugin's verdict cache may
hold verdicts computed under the old policy, so call
`ctx.agentjail.invalidateCache()`.

The daemon's own failure behavior on a bad policy load - keep the last verified
policy, or deny - is AgentJail's to define. The plugin's job is not to soften
whichever it chooses.
