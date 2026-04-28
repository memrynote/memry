# Task 02: Wire `@memry/i18n` into the desktop app

> **Plan:** Task 2 (Install Dependencies into Desktop App)
> **Depends on:** Task 01 (`@memry/i18n` package exists)
> **Dependents:** Tasks 14–24 (any code in `apps/desktop` importing from `@memry/i18n`)

## Pre-flight check

```bash
pwd                                       # ../memry-i18n-phase-a
git status                                # clean
ls packages/i18n/package.json             # exists from Task 01
git log --oneline -3                      # last commit: "feat(i18n): scaffold @memry/i18n package skeleton"
```

## Your job

Add `@memry/i18n: workspace:*` to `apps/desktop/package.json` so the desktop app can import from `@memry/i18n/main`, `@memry/i18n/renderer`, etc.

## Steps

1. Open `apps/desktop/package.json` and locate the `dependencies` section. Find the alphabetical position among other `@memry/*` deps (e.g., between `@memry/db-schema` and `@memry/rpc`).

2. Insert:

```json
"@memry/i18n": "workspace:*",
```

3. Install:

```bash
pnpm install
```

Expected: lockfile updates; `@memry/i18n` is now linked into `apps/desktop/node_modules`.

4. Verify the workspace link resolves:

```bash
ls apps/desktop/node_modules/@memry/i18n/package.json
```

Expected: file exists (symlinked to `packages/i18n`).

5. Run desktop typecheck (sanity — should still pass since we don't import from `@memry/i18n` anywhere yet):

```bash
pnpm typecheck:desktop
```

Expected: passes.

6. Commit:

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(i18n): wire @memry/i18n into desktop app"
```

## Exit criteria

- [ ] `apps/desktop/package.json` has `"@memry/i18n": "workspace:*"` in `dependencies`
- [ ] `pnpm-lock.yaml` updated
- [ ] `apps/desktop/node_modules/@memry/i18n` symlink resolves
- [ ] `pnpm typecheck:desktop` passes
- [ ] One commit created

## Skills to use

None — straightforward dependency wiring.

## Report back

```
✅ Task 02 complete.
Commit SHA: <abbrev>
typecheck:desktop: passes
Next: Task 03 (locale-api in contracts)
```
