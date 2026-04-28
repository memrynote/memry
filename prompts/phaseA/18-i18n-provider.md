# Task 18: Implement `<I18nProvider>` component

> **Plan:** Task 18 (Implement `<I18nProvider>` Component)
> **Depends on:** Task 17 (`createRendererI18n` exists)
> **Dependents:** Task 21 (renderer boot wraps `<App>`)

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/renderer/index.ts                    # exists from Task 17
```

## Your job

Tiny wrapper around react-i18next's `<I18nextProvider>` that takes a `i18n` instance and renders children inside the provider. Keeping our own component (rather than re-exporting react-i18next's) lets us add app-specific concerns (logging, error boundary) later without churning consumers.

## Steps

1. **Implement `packages/i18n/src/renderer/provider.tsx`**:

```tsx
import { I18nextProvider } from 'react-i18next'
import type { ReactNode } from 'react'
import type { I18nInstance } from './index'

interface I18nProviderProps {
  i18n: I18nInstance
  children: ReactNode
}

export function I18nProvider({ i18n, children }: I18nProviderProps): JSX.Element {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
```

2. **Run typecheck**:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

3. **Commit**:

```bash
git add packages/i18n/src/renderer/provider.tsx
git commit -m "feat(i18n): add <I18nProvider> wrapper component"
```

## Exit criteria

- [ ] `packages/i18n/src/renderer/provider.tsx` exists
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

None — small typed wrapper.

## Report back

```
✅ Task 18 complete.
Commit SHA: <abbrev>
Typecheck: passes
Next: Task 19 (useT and useDirection hooks)
```
