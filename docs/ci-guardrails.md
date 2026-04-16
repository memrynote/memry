# CI Guardrails

This doc covers CI safety nets that run on every PR and push to `main`. These are separate from the main `quality` pipeline (lint/typecheck/test) and guard against classes of failure that slip through normal review.

## Lockfile Drift (`.github/workflows/lockfile-drift.yml`)

### What it does

Runs on any PR or push to `main` that touches `**/package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`. Two checks:

1. **Frozen install** — `pnpm install --frozen-lockfile --ignore-scripts` fails if `package.json` and `pnpm-lock.yaml` disagree.
2. **Regen diff** — snapshots the committed lockfile, runs `pnpm install --lockfile-only --ignore-scripts`, then diffs. A non-empty diff fails the job.

The second check is the load-bearing one. `--frozen-lockfile` only catches mismatches that pnpm treats as hard errors; regen-diff catches the subtler case where pnpm would silently rewrite the lockfile on the next local install.

### Fixing a drift failure

```bash
pnpm install         # regenerate the lockfile locally
git add pnpm-lock.yaml
git commit -m "chore: refresh pnpm-lock.yaml"
git push
```

If the diff in CI points at a package you didn't touch, it usually means an upstream `package.json` was bumped and the lockfile was committed without a matching install. Regenerating locally brings them back in sync.

### Why it matters

Pinning the lockfile is the cheapest way to get reproducible builds:

- Every dev machine, CI runner, and release build resolves the exact same dependency graph.
- Transitive version drift (the common source of "works on my machine" bugs) gets caught at PR time instead of leaking into a release.
- Supply-chain attacks via surprise transitive upgrades are blocked — a lockfile bump is always a reviewable diff.

## Local Helpers

Two root-level scripts mirror the CI checks for fast pre-push feedback:

| Script                | What it runs                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `pnpm check:lockfile` | Mirrors the drift workflow locally via `scripts/check-lockfile.js`.  |
| `pnpm outdated:check` | `pnpm outdated -r --format list`, truncated to 100 lines.            |

Run `pnpm check:lockfile` before pushing a dep change to catch drift without waiting on CI. Run `pnpm outdated:check` when triaging "why is this dep so old" — it surfaces every workspace package with an available minor or major bump.
