# Task 09: Implement `loadResources()` for main process (TDD)

> **Plan:** Task 8 (Implement `main/load-resources.ts`)
> **Depends on:** Task 08 (locale JSONs + RESOURCES barrel exist)
> **Dependents:** Task 10 (`createMainI18n`)

## Pre-flight check

```bash
pwd                                                        # ../memry-i18n-phase-a
git status                                                 # clean
ls packages/i18n/src/locales/index.ts                     # exists from Task 08
pnpm --filter @memry/i18n typecheck                       # passes
```

## Your job

Add a synchronous `loadResources(locale)` that returns the full set of namespaces for that locale. Used by the main process where async loading is not an option (the native menu builds before the first window opens).

## Steps

1. **Write the failing test** — `packages/i18n/src/main/load-resources.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadResources } from './load-resources'

describe('loadResources', () => {
  it('returns all namespaces for English', () => {
    const result = loadResources('en')
    expect(result.common).toBeDefined()
    expect(result.settings).toBeDefined()
    expect(result.menu).toBeDefined()
  })

  it('returns the actual translated strings', () => {
    const result = loadResources('tr')
    expect(result.menu.file.label).toBe('Dosya')
  })
})
```

2. **Run test to verify it fails**:

```bash
pnpm --filter @memry/i18n test load-resources
```

Expected: FAIL — "Cannot find module './load-resources'".

3. **Implement `packages/i18n/src/main/load-resources.ts`**:

```ts
import type { Locale } from '../shared/config'
import { RESOURCES } from '../locales'
import type { Resources } from '../shared/types'

/**
 * Returns the full set of namespaces for a locale, loaded eagerly via the
 * static RESOURCES map. Used by the main-process i18next instance, which
 * must initialize synchronously before the native menu is built.
 */
export function loadResources(locale: Locale): Resources {
  return RESOURCES[locale]
}
```

4. **Run test to verify it passes**:

```bash
pnpm --filter @memry/i18n test load-resources
```

Expected: 2 tests pass.

5. **Commit**:

```bash
git add packages/i18n/src/main/load-resources.ts packages/i18n/src/main/load-resources.test.ts
git commit -m "feat(i18n): add synchronous resource loader for main process"
```

## Exit criteria

- [ ] `load-resources.test.ts` exists with 2 tests
- [ ] `load-resources.ts` exists
- [ ] All tests pass
- [ ] One commit

## Skills to use

- **`superpowers:test-driven-development`** — required
- **`superpowers:verification-before-completion`** — confirm tests pass

## Report back

```
✅ Task 09 complete.
Commit SHA: <abbrev>
Tests: 2 pass
Next: Task 10 (createMainI18n, TDD)
```
