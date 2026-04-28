# Task 04: Create `packages/i18n/src/shared/config.ts`

> **Plan:** Task 3 (Implement `shared/config.ts`)
> **Depends on:** Task 03 (`@memry/contracts/locale-api` exists with `Locale`, `LocaleSchema`, `SUPPORTED_LOCALES`, `FALLBACK_LOCALE`)
> **Dependents:** Tasks 05, 09, 10, 14, 17, 19, 23 (anything reading display names or namespaces)

## Pre-flight check

```bash
pwd                                                  # ../memry-i18n-phase-a
git status                                           # clean
cat packages/contracts/src/locale-api.ts | head -20  # confirm Task 03's exports exist
```

## Your job

Add display names and namespace registry to `@memry/i18n/shared`. Re-export the canonical types from `@memry/contracts/locale-api` so callers have one import path for runtime concerns.

## Steps

1. Create `packages/i18n/src/shared/config.ts`:

```ts
/**
 * Locale configuration: display names and namespace registry.
 *
 * Locale identity (LocaleSchema, Locale type, SUPPORTED_LOCALES, FALLBACK_LOCALE)
 * is owned by @memry/contracts/locale-api. This file extends that with the
 * runtime/UI concerns: human-readable display names and the i18next namespace list.
 *
 * LOCALE_DISPLAY_NAMES are intentionally NOT translated — each language's
 * name is shown in its own native script so users can find their language
 * regardless of the current UI locale.
 */

import { type Locale } from '@memry/contracts/locale-api'

export {
  LocaleSchema,
  type Locale,
  SUPPORTED_LOCALES,
  FALLBACK_LOCALE
} from '@memry/contracts/locale-api'

export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية'
}

export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'settings',
  'errors',
  'menu'
] as const

export type I18nNamespace = (typeof I18N_NAMESPACES)[number]

export const DEFAULT_NAMESPACE: I18nNamespace = 'common'
```

2. Run typecheck:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: **fails** with "Cannot find module './direction'" or similar — barrel `shared/index.ts` doesn't exist yet. That's OK, fixed in Task 07. **Don't commit yet** if barrel issue blocks; commit at the end of Task 07.

Alternative: commit now (the file standalone is correct). Subsequent tasks can rely on the file being present.

3. Commit:

```bash
git add packages/i18n/src/shared/config.ts
git commit -m "feat(i18n): add display names and namespace registry config"
```

## Exit criteria

- [ ] `packages/i18n/src/shared/config.ts` exists with the content above
- [ ] File compiles in isolation (the imports resolve)
- [ ] One commit created

## Skills to use

None — straight implementation.

## Report back

```
✅ Task 04 complete.
Commit SHA: <abbrev>
Note: full package typecheck deferred until Task 07 completes the barrel
Next: Task 05 (direction helper, TDD)
```
