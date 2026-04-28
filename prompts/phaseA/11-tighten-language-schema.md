# Task 11: Tighten `GeneralSettings.language` to `LocaleSchema`

> **Plan:** Task 11 (Tighten `GeneralSettings.language`)
> **Depends on:** Task 03 (`LocaleSchema` in contracts)
> **Dependents:** Tasks 14, 15 (handler reads/writes settings); ~30 existing files reading `settings.general.language`

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
grep -n "language: z.string" packages/contracts/src/settings-schemas.ts   # find current loose def
```

## Your job

Replace `language: z.string().min(2).max(5)` with `language: LocaleSchema` in `GeneralSettingsSchema`. The default `'en'` stays unchanged (it's a valid enum member).

This tightening propagates through the ~30 consumer files. Most won't need changes (they treat `settings.general.language` as a string already), but if any consumer compares against locales not in the enum (e.g., `'es'`), TypeScript will flag it.

## Steps

1. **Read the existing schema** to confirm the line:

```bash
sed -n '15,30p' packages/contracts/src/settings-schemas.ts
```

You should see (around line 22):

```ts
language: z.string().min(2).max(5),
```

2. **Edit `packages/contracts/src/settings-schemas.ts`**:

   - Add the import at the top of the file:

```ts
import { LocaleSchema } from './locale-api'
```

   - Replace the loose-string field with the enum:

```ts
language: LocaleSchema,
```

3. **Run contract typecheck**:

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: passes — `'en'` in `GENERAL_SETTINGS_DEFAULTS` is a valid enum member.

4. **Run contract tests** (the existing settings-schemas test may have something that exercises the loose string):

```bash
pnpm --filter @memry/contracts test settings-schemas
```

Expected: passes. If a test is using `language: 'foo'` to verify acceptance of arbitrary strings, update it: either pick a valid locale, or change the test's intent to verify rejection.

5. **Run desktop typecheck** to surface downstream breakage:

```bash
pnpm typecheck:desktop
```

Expected: passes. If any of the 30 consumer files compare against a locale not in the enum, TypeScript flags it. Investigate per case — likely the comparison was always unreachable. Report any fixes needed.

6. **Commit**:

```bash
git add packages/contracts/src/settings-schemas.ts
git commit -m "feat(i18n): tighten GeneralSettings.language to LocaleSchema"
```

## Exit criteria

- [ ] `language` is `LocaleSchema` (not `z.string().min(2).max(5)`)
- [ ] `LocaleSchema` import added at top
- [ ] `pnpm --filter @memry/contracts typecheck` passes
- [ ] `pnpm typecheck:desktop` passes
- [ ] Contract tests pass
- [ ] One commit

## Skills to use

- **`superpowers:verification-before-completion`** — run BOTH typechecks before claiming done

## Report back

```
✅ Task 11 complete.
Commit SHA: <abbrev>
Contract typecheck: passes
Desktop typecheck: passes
Test: passes
Downstream impact: <e.g. "no fixes needed" or "fixed N consumer comparisons">
Next: Task 12 (validate IPC contract)
```
