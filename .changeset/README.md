# Changesets

A pull request that changes the published package adds a **changeset**: a small
Markdown file in this directory that records the bump type and one changelog
line. Nothing in `CHANGELOG.md` or `package.json` is edited by hand.

```sh
npx changeset            # pick a bump, write the summary
```

On `main`, the release workflow keeps an open **"Version Packages"** pull
request. Merging it runs `changeset version` (which consumes every changeset,
bumps `package.json`, and writes `CHANGELOG.md`) and then publishes to npm. A
pull request that only touches tests, docs, CI, or internal refactors needs no
changeset.

The bump type is the highest of those recorded, and while the major version is
`0` a `minor` bump may include a breaking change.

- `patch` — a fix that changes no documented behavior.
- `minor` — a new feature, a new configuration field, or a behavior change.
- `major` — reserved for `1.0.0` and beyond; prefer `minor` at `0.x`.

See [changesets](https://github.com/changesets/changesets) for the full model.
