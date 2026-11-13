---
'dsh-plugin-agentjail': patch
---

The CodeQL workflow could not close an alert marked by an inline suppression.
GitHub code scanning ignores the SARIF `suppressions` property, so the comment
alone did nothing, and the alert-suppression query was not in the default suite,
so the comment was not even parsed. The workflow now loads
`codeql/javascript-queries:AlertSuppression.ql` and runs
`advanced-security/dismiss-alerts` on `main` to dismiss the alerts the SARIF marks
as suppressed. This closes the remaining `js/http-to-file-access` alert.
