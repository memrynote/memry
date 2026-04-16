# Upgrading drizzle-orm

Guardrails for bumping `drizzle-orm` across the memry workspace. Drizzle 0.x minor bumps have historically contained SQL dialect changes; silent schema drift against a user's local vault = data corruption. Follow the checklist.

Context: `.claude/plans/tech-debt-remediation.md § 6.3` (Phase 6 U3) — the reason this doc exists. This is the companion doc to `docs/upgrading-electron.md` (§ 6.5).

## Pre-bump checklist

Before touching any `package.json`:

- Read the Drizzle [release notes](https://github.com/drizzle-team/drizzle-orm/releases) for every version between current and target.
- Flag any of the following in the changelog:
  - SQL dialect changes (column types, default serialization, index syntax).
  - Migration generator changes (new/removed SQL in generated files).
  - Type signature changes on `sqliteTable`, `index`, `foreignKey`, `check`.
  - `better-sqlite3` compat caveats.
- If anything above is present, plan a migration review pass before bumping.

## Execution steps

All three packages must stay in lockstep. Bump them together:

- `apps/desktop/package.json`
- `packages/db-schema/package.json`
- `packages/storage-data/package.json`

```bash
# 1. Edit the three files above to the new version.
# 2. Refresh the lockfile.
pnpm install

# 3. Regenerate migrations. ANY diff = schema drift. Review carefully.
pnpm db:generate

# 4. Full workspace typecheck.
pnpm typecheck

# 5. Focused tests.
pnpm --filter @memry/storage-data test
pnpm --filter @memry/db-schema test
pnpm --filter @memry/desktop test:main

# 6. E2E smoke (vault + sync flows).
pnpm test:e2e --shard=1/3

# 7. Manual: launch app, create note, close, reopen, confirm vault loads.
pnpm dev:a
```

If step 3 produces a diff, stop and audit. A harmless patch bump should not change generated SQL. If SQL changes are expected from the changelog, diff each line vs the old migration and confirm the migration path is forward-compatible for users who already applied the old file.

## Rollback

If a bump breaks locally or in CI:

```bash
git revert <bump-commit-sha>     # prefer revert
pnpm install                     # re-sync lockfile to pre-bump version
```

Do not force-push to recover. Revert keeps history auditable and works with branch protection. If a user-facing vault has already applied a bad generated migration, the revert alone will not undo the SQLite changes — ship a corrective forward migration.

## Known gotchas

- **Drizzle — nullable JSON columns**: `.values()` inserts for nullable JSON columns need `null`, not `undefined`. Passing `undefined` silently omits the column.
- **Zod v4** (cited for doc tone, not drizzle-specific): `z.record(z.unknown())` throws in `safeParse`. Always use `z.record(z.string(), z.unknown())`.
- **better-sqlite3 mismatch**: if a drizzle bump coincides with a better-sqlite3 update, run `pnpm rebuild better-sqlite3` for Node tests and `bash apps/desktop/scripts/ensure-native.sh electron` for Electron/E2E. Using the Node fix for Electron silently fails with `ERR_DLOPEN_FAILED`. Use `pnpm check:native` (Phase 6 U1) to diagnose.

## Pre-production caveat

Per `CLAUDE.md`, the repo can nuke and recreate its own DB schema freely — no backward-compat needed for dev fixtures. But **users' local vaults** are real and will execute any new migrations on next app launch. Treat every generated SQL diff as a migration that will run against real user data.

## Version-alignment invariant

All three `package.json` files must pin the same `drizzle-orm` version. CI does not enforce this today (tracked in `.claude/plans/tech-debt-remediation.md § 6.3`). If you bump one, bump all three.
