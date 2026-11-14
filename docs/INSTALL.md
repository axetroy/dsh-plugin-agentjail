# Installing AgentJail

The plugin enforces policy by asking a daemon. This document explains how the
plugin finds that daemon, what it does when it cannot, and the one trust decision
the automatic path asks you to make.

## What has to exist

Nothing beyond the plugin. The published package carries the AgentJail build the
plugin was tested against, so a fresh install has a working engine with no second
step.

The plugin does not require the daemon to be running, and it does not require the
AgentJail installer's shell hooks — those exist to govern other agents, and this
plugin governs DeepSeek Harness through its own `tools/pre-execute` gate.

A socket that is already answering is used as-is. Everything below is about the
case where no daemon is running.

## Search order

When no daemon answers, the plugin looks for a binary in this order and stops at
the first usable one:

1. `daemon.binary` in the plugin configuration.
2. `AGENTJAIL_BIN` in the environment.
3. `vendor/<platform>-<arch>/agentjail` inside the installed package — the
   vendored build, which is the default.
4. `agentjail` on `PATH`.
5. `~/.agentjail/dsh-plugin-agentjail/bin/agentjail`, the managed download
   directory, only when `daemon.managedInstall: true`.

A configured path is authoritative. If `daemon.binary` names a file that is not
an executable regular file, the plugin reports that path in its failure message
and does not fall back to a different binary. Silently running something other
than what you configured is the more surprising failure.

## The vendored build

Vendoring exists so that an upstream release cannot change the engine under a
plugin that was not tested against it. The build is pinned in `vendor.lock.json`,
downloaded and checksum-verified by `scripts/vendor-agentjail.mjs` at release
time, and shipped in the package. Nothing is fetched at install time or at run
time.

Before starting any binary, the plugin runs `<binary> --no-color version` and
classifies the result against `SUPPORTED_VERSION_WINDOW` (`>=1.8.0 <2.0.0`):

| Outcome    | What happens                                                               |
| ---------- | -------------------------------------------------------------------------- |
| In window  | The binary is started.                                                     |
| Too old    | Refused. The plugin keeps applying `failureAction`.                        |
| Too new    | Refused, because the next major is where the wire contract may be retired. |
| Unreadable | Refused. An unknown version is never treated as compatible.                |

A refusal leaves the plugin denying protected calls, which is the correct
posture: no verified engine means no tool runs. The window is fixed for a given
plugin release; set `daemon.requireSupportedVersion: false` to skip the check
entirely.

To move to a new upstream build, edit `vendor.lock.json` and let CI vendor it. The
lock file is a reviewed change on purpose.

## The three cases

### A daemon is already running

The plugin probes the socket once. A daemon that answers is adopted: the plugin
starts nothing, and it will not stop that daemon when the plugin unloads. This is
the case for a daemon you manage yourself, whether through `agentjail install`,
systemd, launchd, or a container entrypoint.

Nothing about your daemon's lifecycle changes. The Settings panel reports
`supervision: external`. Reload is not attempted against an adopted daemon,
because the plugin has no control token for it and reloading a daemon it does not
own is not its business.

### No daemon is running

With `daemon.supervise: true` (the default), the plugin starts the resolved binary
with `daemon.args`, waits up to `daemon.startTimeoutMs` for it to answer, and
reports `supervision: started`.

Three things are deliberately explicit about that start:

- **The socket is a flag.** The plugin passes `--socket`, `--db`, and `--log`.
  Upstream's daemon does not read `AGENTJAIL_SOCKET`, so without the flag it would
  bind its own default socket and the plugin would never reach the daemon it
  started.
- **`HOME` is private.** The daemon runs with `HOME` set to a directory inside the
  plugin's state root. Upstream derives its control socket and control token from
  `HOME`, so this keeps a start from reaching a stale control plane left behind by
  an unrelated AgentJail install.
- **The child is detached** and leads its own process group. When the plugin
  unloads it sends `SIGTERM` to that group, and only to that group. A daemon the
  plugin did not start is never signalled.

If the daemon does not answer in time, the plugin reports why and keeps applying
the configured `failureAction`. Supervision failing is not a reason to allow a
call.

### Why the plugin starts the daemon rather than asking you to

Starting a daemon is a real side effect, so the default is the one that asks
least of you. Three options were considered:

1. **Require the operator to run a daemon.** Lowest plugin complexity, but every
   install becomes two steps, and a forgotten step leaves the plugin applying its
   failure action — protection silently off or every call denied. Requiring a
   manual step for the security control to work is the wrong default.
2. **Evaluate in a short-lived child process, no daemon.** This is the design
   that would avoid a long-lived process entirely, and it is not possible with
   the upstream build. The policy engine is compiled into `agentjail`, the
   daemon is the only thing that loads it, `agentjail-hook` forwards to the
   daemon and **allows** the call when it cannot reach it, and the daemonless
   fallback keeps only three self-protection rules. The measurements are in
   `DESIGN.md` §3.3.1.
3. **Supervise a daemon, and adopt one that is already running.** The plugin
   starts a daemon only when nothing answers, and stops only what it started.

Option 3 is the default because it needs no second step from you, never touches
a daemon you run yourself, and never turns an unavailable engine into an allow.
Set `daemon.supervise: false` if you would rather run the daemon yourself; the
plugin then adopts whatever answers and starts nothing.

### What the plugin does when it unloads

Unloading is where a supervised process either cleans up or becomes litter, so
the behavior is exact:

- **A daemon the plugin started is signalled with `SIGTERM`,** to its process
  group only. Upstream removes the socket and releases the database on a clean
  exit, and the plugin waits for queued audit records to land first.
- **A daemon the plugin did not start is never signalled.** Adopting a daemon
  does not take ownership of it, so an unload cannot remove protection from
  another session.
- **A `SIGKILL` of the host process leaves the daemon running.** A detached child
  is not tied to the parent's lifetime, and upstream's daemon has no
  parent-death watchdog or idle self-exit. This is deliberate — the daemon is
  meant to outlive one session — but it means an unclean kill leaves a daemon
  behind. To stop a leftover daemon, find it by its socket and send `SIGTERM`;
  upstream removes the socket and releases the database on a clean exit:

  ```sh
  pkill -TERM -f 'dsh-plugin-agentjail/run/daemon.sock'
  ```

  Do not rely on `agentjail daemon stop`: against a daemon started with an
  explicit `--socket`, it waits on the control plane and does not return.

- **The plugin's state root is not removed on unload.** The audit trail, the
  daemon's database, and the control token are evidence and configuration, not
  scratch space. Removing them is a separate, explicit act.

### You want to own the engine

Point at a binary. Install AgentJail yourself and set `daemon.binary`, or put it
on `PATH`:

```sh
curl -fsSL https://raw.githubusercontent.com/LuD1161/agentjail/main/install.sh | sh
```

The upstream installer verifies a signed release manifest, and you see exactly
what was installed. A configured binary still goes through the version gate, so a
build the plugin does not understand is refused rather than run.

Alternatively, set `daemon.managedInstall: true`. On first load, if no binary is
resolvable, the plugin downloads the release archive for the running platform from
`daemon.releaseBaseUrl`, verifies its SHA-256 against the release's `SHA256SUMS`,
extracts it, and installs it to `daemon.managedDir` (default
`~/.agentjail/dsh-plugin-agentjail/bin`).

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

The Settings panel reports `supervision: disabled`, and an unreachable engine
still resolves `failureAction`.

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
