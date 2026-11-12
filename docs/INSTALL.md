# Installing AgentJail

The plugin enforces policy by asking a daemon. This document explains how the
plugin finds that daemon, what it does when it cannot, and the one trust decision
the automatic path asks you to make.

## What has to exist

One thing: an `agentjail` binary on the machine. The plugin does not require the
daemon to be running, and it does not require the AgentJail installer's shell
hooks — those exist to govern other agents, and this plugin governs DeepSeek
Harness through its own `tools/pre-execute` gate.

A socket that is already answering is used as-is. Everything below is about the
case where no daemon is running.

## Search order

When no daemon answers, the plugin looks for a binary in this order and stops at
the first usable one:

1. `daemon.binary` in the plugin configuration.
2. `AGENTJAIL_BIN` in the environment.
3. `agentjail` on `PATH`.
4. `~/.agentjail/dsh-plugin-agentjail/bin/agentjail`, the managed download
   directory.

A configured path is authoritative. If `daemon.binary` names a file that is not
an executable regular file, the plugin reports that path in its failure message
and does not fall back to a different binary. Silently running something other
than what you configured is the more surprising failure.

## The three cases

### A daemon is already running

The plugin probes the socket once. A daemon that answers is adopted: the plugin
starts nothing, and it will not stop that daemon when the plugin unloads. This is
the case for a daemon you manage yourself, whether through `agentjail install`,
systemd, launchd, or a container entrypoint.

Nothing about your daemon's lifecycle changes. The dashboard reports
`supervision: external`.

### The binary exists but no daemon is running

With `daemon.supervise: true` (the default), the plugin starts
`agentjail daemon` with the configured `daemon.args`, waits up to
`daemon.startTimeoutMs` for it to answer, and reports `supervision: started`.

The child is detached and leads its own process group. When the plugin unloads it
sends `SIGTERM` to that group, and only to that group. A daemon the plugin did not
start is never signalled.

If the daemon does not answer in time, the plugin reports why and keeps applying
the configured `failureAction`. Supervision failing is not a reason to allow a
call.

### Nothing is installed

Two options, and the difference between them is who trusts what.

**Point at a binary.** Install AgentJail yourself and set `daemon.binary`, or put
it on `PATH`:

```sh
curl -fsSL https://raw.githubusercontent.com/LuD1161/agentjail/main/install.sh | sh
```

This is the recommended path. The upstream installer verifies a signed release
manifest, and you see exactly what was installed.

**Let the plugin download one.** Set `daemon.managedInstall: true`. On first load,
if no binary is resolvable, the plugin downloads the release archive for the
running platform from `daemon.releaseBaseUrl`, verifies its SHA-256 against the
release's `SHA256SUMS`, extracts it, and installs it to `daemon.managedDir`
(default `~/.agentjail/dsh-plugin-agentjail/bin`).

This is off by default. Downloading and executing a release binary is your trust
decision, not a plugin default.

## What the managed download verifies, and what it does not

The download fails closed at every step:

| Step                      | Check                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| Fetch `SHA256SUMS`        | Must be present and readable, or nothing is installed.                    |
| Look up the archive entry | A manifest with no digest for the archive is refused, not guessed at.     |
| Fetch the archive         | Refused past `daemon.maxArchiveBytes`.                                    |
| Verify the digest         | A mismatch discards the download and installs nothing.                    |
| Extract                   | Runs into a fresh temporary directory, not over the install location.     |
| Install                   | Written to a temporary name and renamed, so a partial write is never run. |

What it does not do is verify the release's `minisign` signature over the
manifest. Upstream publishes one, but verifying it needs a signature tool that
cannot be assumed present. The practical consequence: the digest check protects
against a corrupted or truncated download and against a manifest that does not
list the asset, but it does not protect against a compromise of the release host
itself. If that is in your threat model, install AgentJail yourself and pin
`daemon.binary`.

## Turning supervision off

`daemon.supervise: false` makes the plugin start nothing and stop nothing. It
still uses a daemon that is already answering. Set this when something else owns
the daemon's lifecycle and you do not want a second actor in it.

The dashboard reports `supervision: disabled`, and an unreachable engine still
resolves `failureAction`.

## Verifying the setup

```sh
# What the plugin sees right now.
curl -s localhost:3080/agentjail/api/health | jq

# A daemon that is answering, and the version it reports.
agentjail status
```

The health endpoint reports `state`, `socketPath`, `supervision`, and
`failureAction`. A `supervision` of `unavailable` means the plugin found no
binary; the `reason` field on the plugin's log line names what it looked for.
