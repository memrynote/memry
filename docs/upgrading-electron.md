# Upgrading Electron

Process doc for the monthly Electron minor bump. Electron bumps ship security patches; deferring them is the main risk vector for a desktop app.

## Current state (as of 2026-04-16)

- `electron`: `^39.8.6` (apps/desktop/package.json)
- `@electron/rebuild`: `^4.0.3`
- `electron-builder`: `^26.0.12`
- `electron-updater`: `^6.6.2`
- `.nvmrc` pins Node to `24` (enforced by `apps/desktop/scripts/ensure-native.sh`)

## Cadence

Electron ships a new stable every ~4 weeks. Pick a standing day each month — suggestion: the first Tuesday after the stable release post goes up.

## Pre-bump checklist

- Read the Electron release notes (https://www.electronjs.org/blog) for the target stable.
- Note Chromium version change. Majors always bump Chromium; minors rarely do.
- Scan the "Breaking changes" section — each release post has one.
- Confirm `electron-builder` and `electron-updater` compatibility. Only a concern on major bumps.
- Confirm `@electron/rebuild` works with the new Electron. It almost always does.

## Execution

1. Bump `electron` in `apps/desktop/package.json` (caret range).
2. `pnpm install` — refreshes `pnpm-lock.yaml`.
3. `bash apps/desktop/scripts/ensure-native.sh electron` — rebuilds `better-sqlite3` and `keytar` against the new Electron ABI.
4. `pnpm typecheck` full workspace. Unit tests run against the **Node** ABI; use `pnpm rebuild:node` afterwards if test modules fail to dlopen (see CLAUDE.md's "dual-path rebuild" gotcha).
5. `pnpm test`.
6. `pnpm build` — verifies app packaging.
7. `pnpm test:e2e` — full Playwright Electron E2E. On Linux CI: `xvfb-run -a pnpm test:e2e`.
8. Local manual smoke: `pnpm dev:a`, create a note, close, reopen the vault, confirm sync works.
9. Auto-updater smoke: tag a test release and let `.github/workflows/release.yml` run end-to-end on it.

## Rollback

- `git revert <bump-commit>`. Do not force-push.
- If the bumped release already shipped to users: publish a same-day patch as a new tagged release. Users on the bumped version will roll forward to the revert via `electron-updater`.

## Known gotchas

- `better-sqlite3 ERR_DLOPEN_FAILED` after an Electron bump: always rebuild for the new ABI with `bash apps/desktop/scripts/ensure-native.sh electron`.
- `autoOpenLastVault` silently fails if native modules mismatch the Electron ABI → E2E tests time out on `.bn-container`. Detectable via `pnpm check:native` (Phase 6 U1 — once landed). If the check isn't available yet, run the rebuild unconditionally.
- `@electron/rebuild` requires the Node version in `.nvmrc` to match the local `node -v`. `ensure-native.sh` enforces this on the electron path.

## References

- Plan source: `.claude/plans/tech-debt-remediation.md § 6.5`.
- Companion doc: `docs/upgrading-drizzle.md` (Phase 6.3 — for DB-layer bumps).
- Native rebuild script: `apps/desktop/scripts/ensure-native.sh`.
- Release workflow: `.github/workflows/release.yml`.
