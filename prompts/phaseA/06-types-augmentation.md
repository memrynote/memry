# Task 06: Add i18next module augmentation for type-checked `t()` calls

> **Plan:** Task 5 (Implement `shared/types.ts`)
> **Depends on:** Task 05 (`config.ts` and `direction.ts` exist)
> **Dependents:** Task 19 (`useT` hook), all later code calling `t('key')` with autocomplete

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/shared/{config,direction}.ts        # both exist
```

## Your job

Add a TypeScript module augmentation that types `t()` calls against the English locale resource files. After this lands (and Task 08 creates the JSONs), `t('inbox.triage.archive')` becomes a compile-time-checked key — typos and stale keys become TS errors instead of runtime "missing translation" silently rendering the key.

The JSONs don't exist yet (Task 08 creates them). This task creates the augmentation module that *will* type against them. Typecheck will fail until Task 08 completes.

## Steps

1. Create `packages/i18n/src/shared/types.ts`:

```ts
/**
 * TypeScript module augmentation that types `t()` calls against the
 * English locale resources (the source of truth). Bad keys become
 * compile-time errors.
 *
 * Usage:
 *   const { t } = useT('inbox')
 *   t('triage.archive')         // ✅ checked against en/inbox.json
 *   t('triage.does-not-exist')  // ❌ TS error
 */

import type common from '../locales/en/common.json'
import type inbox from '../locales/en/inbox.json'
import type notes from '../locales/en/notes.json'
import type journal from '../locales/en/journal.json'
import type calendar from '../locales/en/calendar.json'
import type settings from '../locales/en/settings.json'
import type errors from '../locales/en/errors.json'
import type menu from '../locales/en/menu.json'

export interface Resources {
  common: typeof common
  inbox: typeof inbox
  notes: typeof notes
  journal: typeof journal
  calendar: typeof calendar
  settings: typeof settings
  errors: typeof errors
  menu: typeof menu
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: Resources
  }
}
```

2. **Don't run typecheck or commit yet.** The JSON imports won't resolve until Task 08 creates the files. This task lands the file in place; Tasks 07–08 make it valid; Task 08 commits with the working state.

   Alternatively, you can commit this file alone (`git commit -m "feat(i18n): add i18next module augmentation"`) and accept that `pnpm typecheck` is broken between this commit and Task 08's commit. Either approach is fine — pick whichever your workflow prefers.

   Recommended: commit alone with note that downstream tasks make typecheck green.

3. Commit:

```bash
git add packages/i18n/src/shared/types.ts
git commit -m "feat(i18n): add i18next type augmentation (resolves at Task 08)"
```

## Exit criteria

- [ ] `packages/i18n/src/shared/types.ts` exists with the augmentation declaration
- [ ] One commit created
- [ ] Typecheck failures (about missing JSON imports) are expected until Task 08

## Skills to use

None — straightforward type definition.

## Report back

```
✅ Task 06 complete.
Commit SHA: <abbrev>
Typecheck status: BROKEN (expected — fixed by Task 08)
Next: Task 07 (shared/index.ts barrel)
```
