---
'dsh-plugin-agentjail': patch
---

The generated Rego templates were rejected by OPA: they used v0 syntax, mixed
statements into object literals, declared `deny_rules` in one shared package
across every template, and called a nonexistent `regex.find_all_stringify`. They
now render as valid Rego v1, one package per template, unioned by a generated
entrypoint, and are evaluated against a real OPA binary in CI.
