---
sidebar_position: 5
title: How Changes Reach Users
description: What happens to your contribution after it is merged
---

# How Changes Reach Users

The short version: **merging is releasing.** Once your pull request is approved
and merged, it goes live on its own. You don't cut a release, tag anything, bump
a version, or ask anyone to deploy.

This page explains what happens after you hit merge, so you know what to expect
and what your change needs from you before it gets there.

## The journey of a change

1. **You open a pull request** against `main`.

2. **Automated checks run.** Which ones depends on what you touched — agent
   validation, unit tests, agent startup, a database seed round-trip, a docs
   build. They need to pass.

3. **A maintainer reviews it.** Every pull request needs approval from a code
   owner before it can merge.

4. **It merges — and it ships.** Production rebuilds and redeploys itself
   automatically, within minutes.

There is no staging step between step 3 and step 4, and no release train to catch.
The review *is* the gate.

:::tip Want a trial run first?
If your change is risky, or you'd just like to watch it run before real
participants do, say so in your pull request. A maintainer can route it through
the test environment first.
:::

## The two branches

| Branch | What it is |
|--------|------------|
| `main` | Production. What study participants are using right now. |
| `development` | The test environment, for work that needs a trial run first. |

Both deploy themselves when something lands on them. As a contributor you'll
normally only ever target `main`.

Documentation-only changes are the one exception to the automatic deploy — a pull
request that touches only Markdown or the docs site won't trigger a rebuild of the
platform. The documentation site publishes itself separately from `main`.

## What you don't need to do

Three things that other projects ask for, which this one handles on your behalf:

- **Don't bump any version numbers.** Not in `package.json`, not in a
  `pyproject.toml`. Maintainers handle versioning.
- **Don't write changelog entries.** Release notes are generated from merged pull
  requests, which is why the next point matters.
- **Don't build or push any images.** Everything is built from source at deploy
  time, including agents — any directory under `agents/` with a `Dockerfile` is
  picked up automatically.

## What your pull request does need

- **A clear description.** It becomes the public record of why the change exists,
  and it feeds the generated release notes. Someone reading it in a year should
  understand the motivation without opening the diff.
- **A flag on anything that needs coordination** — a database migration, a config
  or secret change, an order-dependent rollout. Because merging deploys straight
  to production, there's no window to catch these afterwards.
- **Green checks.** A red check will not be merged around.

## Two things release on their own schedule

Almost everything ships the moment it merges. Two exceptions are worth knowing
about.

### The Agent SDK

The Python SDK (`stella-ai-agent-sdk`) is published separately to
[PyPI](https://pypi.org/project/stella-ai-agent-sdk/), because a version number
there is **permanent** — once `0.5.0` is published it can never be reused, even if
the release is deleted. That makes publishing worth a deliberate decision rather
than an automatic consequence of merging.

For you, nothing changes: your SDK change merges to `main` like any other, and a
maintainer publishes it as a release when it's ready. Just mention in your pull
request if your change should go out promptly rather than waiting for the next
release.

If you're **building an agent** rather than changing the SDK, you don't need this
repository at all — install the published package and work in your own project:

```bash
pip install stella-ai-agent-sdk
```

### The STELLA version number

The version on the README badge and in `CITATION.cff` is bumped by maintainers
when a batch of work is worth marking. It's a label for humans and for citation,
not a deployment trigger — production is already running the latest `main`
regardless of what that number says.

The same mechanism produces **study cuts**: frozen, citeable versions tagged with
a study name, so the exact software behind a published paper stays reproducible
and referenceable. If your work is part of a study, ask a maintainer whether a cut
is needed.

## Reading the tags

If you go looking through the repository's tags, you'll find three kinds. They
answer different questions:

| Tag | Means |
|-----|-------|
| `v0.3.0` | A marked version of STELLA, for citation and reference |
| `prod/0.3.0-9-g5912175` | One specific deploy that reached production |
| `sdk-v0.5.0` | A release of the Agent SDK published to PyPI |

The `prod/` tags accumulate quickly — one per merge to `main` — and exist as an
audit trail of what production has actually run, not as releases to read.

## Next Steps

- [Pull Request Process](./pull-request-process.md) — submitting changes
- [Coding Standards](./coding-standards/index.md) — style guide
