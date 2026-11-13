---
'dsh-plugin-agentjail': patch
---

A release tag read from a redirect target was interpolated into a file name and a
URL path without validation. A crafted tag such as `../../etc/passwd` could steer
the archive write outside the install directory. `isSafeReleaseTag` now restricts
a tag to a release-tag shape, and the archive write asserts containment under the
working directory. This addresses CodeQL `js/http-to-file-access`.
