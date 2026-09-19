# Contributing to GuKi Chat

Thank you for helping improve GuKi Chat. The project values small, reviewable changes, clear
problem statements, and a release process that keeps ordinary contributions separate from
publishing a plugin version.

## Before you start

For a substantial change, please find an existing issue or open one first. Wait for the issue to
be accepted and scoped by a maintainer before investing in implementation. Ask to claim accepted
work so that two contributors do not solve the same problem. Small documentation and focused bug
fixes can go straight to a pull request when the intent is clear.

Please do not disclose a security vulnerability in a public issue. Follow [the security policy](SECURITY.md).

## Local development

GuKi Chat is an Obsidian desktop plugin. Use a current Node.js installation and install the exact
locked dependency tree:

```sh
npm ci
```

Useful checks are:

```sh
npm run lint
npm run check
npm run build
```

`npm run check` includes the repository's capture/document privacy checks and offline checks.
Please run the relevant checks before opening a pull request and include any limitation in the PR
description.

## Branches and pull requests

Use a short-lived branch based on `main`, for example `feat/issue-42-command`,
`fix/issue-42-permission-prompt`, or `docs/contributing-guide`. There is no permanent
`development` branch. Keep a branch focused on one issue or one coherent change.

Open a pull request against `main`. Link the issue with `Closes #123` when the change resolves it.
Describe the user problem, the approach, compatibility impact, validation performed, and any
privacy or security considerations. Update documentation and examples when behavior or workflow
changes.

Pull request titles use the Conventional Commits style, such as `fix: preserve permission cards`
or `docs: explain local checks`. The contributor commit history is not separately policed because
the maintainer squash-merges the pull request using its title.

A maintainer merges only after the required checks pass, review feedback is addressed, and the
change is within the accepted scope. Ordinary pull request merges accumulate safely on `main`; a
separate, deliberate release decision is required to publish a plugin version.

## Communication and conduct

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Questions and ordinary bug reports belong
in GitHub issues. Security reports belong in the private channel described by [SECURITY.md](SECURITY.md).
