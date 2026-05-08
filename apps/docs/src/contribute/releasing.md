# Releasing

How packaged builds, sync server deploys, and changelogs are produced.

## Versioning

The repo follows semver. Versions live in `package.json` files and propagate to packaged installers via electron-vite + electron-builder.

## CHANGELOG

`CHANGELOG.md` at the repo root is the source of truth for human-readable release notes.

- Update during `/merge` (the workflow enforces it).
- Group by user-facing impact, not by commit type.
- Link to PRs and issues where relevant.

## Release Drafter

Release Drafter aggregates merged PRs into a draft GitHub Release based on PR labels.

- Branch labels are narrowed to release-relevant changes (no `chore: ci/lint/test` noise).
- The drafter posts updates after each merge to `main`.
- Use the project `release` skill when shipping. It rewrites the draft from PR descriptions, keeps
  PR references, dispatches the publish workflow, and watches it to completion.
- Release assets are created only by the publish workflow, not by draft updates.

## Packaged Installers (Desktop)

Built via electron-vite + electron-builder.

| Platform | Artifact |
| --- | --- |
| macOS | `.dmg` (universal: x64 + arm64) |
| Windows | `.exe` (NSIS installer) |
| Linux | `.AppImage`, `.deb` |

Notarization (macOS) and signing are handled in CI with credentials in repo secrets.

## Sync Server Deploy

The Cloudflare Workers app deploys via `wrangler` on its own cadence:

```bash
cd apps/sync-server
pnpm deploy
```

D1 migrations are applied separately:

```bash
pnpm db:migrate:apply --env production
```

Sync server and desktop releases must stay **forward-compatible**: an old desktop must still talk to a new server, and vice versa, for the duration of any rolling upgrade.

## Pre-Release Checklist

For a desktop release:

- [ ] `pnpm lint` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm test:e2e` green
- [ ] CHANGELOG entry merged
- [ ] Version bumped in `apps/desktop/package.json`
- [ ] Sync server compatible with the desktop release
- [ ] Migrations safe under concurrent writes (ALTER TABLE on hot tables is risky)
- [ ] Native modules rebuild successfully on each target platform in CI

For the sync server:

- [ ] `pnpm --filter @memry/sync-server test` green
- [ ] D1 migration tested against a copy of staging
- [ ] No breaking API changes without a `crypto_version` bump
- [ ] Backout plan documented in the PR

## Hotfix Path

For an urgent fix:

1. Branch from the latest tag (`hotfix/<slug>` from the release branch or tag commit).
2. Fix and test locally.
3. Open a PR; tag with `hotfix` so Release Drafter promotes it appropriately.
4. After merge, tag a patch release and re-run packaged builds.

## Post-Release

- Monitor crash reports / sync error rates (when those land — see [Roadmap](/roadmap)).
- Watch the `#memry-releases` channel for user reports during the first 48 hours.
- Update [Roadmap](/roadmap) to reflect what shipped.
