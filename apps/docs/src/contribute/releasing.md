# Releasing

How packaged builds and changelogs are produced.

## Versioning

The repo follows semver. Versions live in `package.json` and propagate to packaged installers.

## CHANGELOG

`CHANGELOG.md` at the repo root is the source of truth for human-readable release notes. Update during `/merge` (the workflow enforces it).

## Release Drafter

Release Drafter aggregates merged PRs into a draft release based on PR labels. Branch labels are narrowed to release-relevant changes.

## Packaged Installers

Electron installers are produced via electron-vite + electron-builder. Targets: macOS (.dmg), Windows (.exe), Linux (.AppImage / .deb).

## Sync Server Deploy

The Cloudflare Workers app is deployed via `wrangler` on its own cadence. Migrations to D1 are applied separately from Worker code.

## Pre-Release Checklist

- [ ] All gates green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`
- [ ] CHANGELOG entry merged
- [ ] Version bumped
- [ ] Sync server compatible with the desktop release
- [ ] Migrations safe under concurrent writes
