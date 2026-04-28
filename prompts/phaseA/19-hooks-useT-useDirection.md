# Task 19: Implement `useT` and `useDirection` React hooks

> **Plan:** Task 19 (Implement `useT` and `useDirection` Hooks)
> **Depends on:** Task 18 (`<I18nProvider>` exists)
> **Dependents:** Task 23 (settings picker uses `useT`)

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/renderer/provider.tsx                # exists from Task 18
```

## Your job

Two hooks:

- `useT(namespace)` — strongly-typed wrapper around `useTranslation` that constrains the namespace argument to `I18nNamespace` enum
- `useDirection()` — returns `'ltr' | 'rtl'` for the current locale, re-renders on language change

Then update the renderer barrel to export everything.

## Steps

1. **Implement `packages/i18n/src/renderer/use-t.ts`**:

```ts
import { useTranslation } from 'react-i18next'
import type { I18nNamespace } from '../shared/config'

/**
 * Strongly-typed translation hook bound to a specific namespace.
 *
 * Usage:
 *   const { t } = useT('inbox')
 *   t('triage.archive')   // checked against en/inbox.json via type augmentation
 */
export function useT(namespace: I18nNamespace) {
  return useTranslation(namespace)
}
```

2. **Implement `packages/i18n/src/renderer/use-direction.ts`**:

```ts
import { useTranslation } from 'react-i18next'
import { localeDirection } from '../shared/direction'

/**
 * React hook returning the current document direction. Re-renders when
 * the active locale changes via i18next's change event.
 */
export function useDirection(): 'ltr' | 'rtl' {
  const { i18n } = useTranslation()
  return localeDirection(i18n.language)
}
```

3. **Update `packages/i18n/src/renderer/index.ts`** to export the new pieces. Append:

```ts
export { I18nProvider } from './provider'
export { useT } from './use-t'
export { useDirection } from './use-direction'
```

(`createRendererI18n` and `I18nInstance` are already exported from Task 17.)

4. **Run typecheck**:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

5. **Commit**:

```bash
git add packages/i18n/src/renderer/use-t.ts packages/i18n/src/renderer/use-direction.ts packages/i18n/src/renderer/index.ts
git commit -m "feat(i18n): add useT and useDirection React hooks"
```

## Exit criteria

- [ ] `use-t.ts` exists
- [ ] `use-direction.ts` exists
- [ ] `renderer/index.ts` re-exports `I18nProvider`, `useT`, `useDirection`
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

None.

## Report back

```
✅ Task 19 complete.
Commit SHA: <abbrev>
Typecheck: passes
Exports from @memry/i18n/renderer: createRendererI18n, I18nInstance, I18nProvider, useT, useDirection
Next: Task 20 (applyLocaleToDocument)
```
