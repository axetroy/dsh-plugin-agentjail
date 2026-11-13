---
'dsh-plugin-agentjail': minor
---

Every configured verdict field is now applied. `defaultAction` governs a call the
engine matched no rule for (previously a no-match allow was taken at face value),
`askFallback` resolves an ask on every path that produces one, `enforcement` is
read through `isEnforcing` so an unrecognized mode fails closed, the deny-rate
alert from the metrics collector reaches the alert sink, and
`governance.alertsEnabled` gates the alert surface without touching enforcement
or the audit trail.
