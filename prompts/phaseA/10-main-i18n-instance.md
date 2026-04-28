# Task 10: Implement `createMainI18n()` factory (TDD)

> **Plan:** Task 9 (Implement `main/index.ts`)
> **Depends on:** Task 09 (`loadResources()` exists)
> **Dependents:** Tasks 14, 15, 16 (handler, boot, menu)

## Pre-flight check

```bash
pwd                                                        # ../memry-i18n-phase-a
git status                                                 # clean
ls packages/i18n/src/main/load-resources.ts               # exists
```

## Your job

Create the main-process i18next instance factory. Synchronous init via the static RESOURCES map (no filesystem I/O). Wires the ICU plugin for plural/gender support. Returns a fully-initialized `I18nInstance`.

## Steps

1. **Write the failing test** — `packages/i18n/src/main/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMainI18n } from './index'

describe('createMainI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a known menu key', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })

  it('returns the key for nonexistent translations', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('menu:nonexistent.key')).toBe('menu:nonexistent.key')
  })

  it('changeLanguage updates the active locale', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('menu:file.label')).toBe('File')
    await i18n.changeLanguage('tr')
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })
})
```

2. **Run test to verify it fails**:

```bash
pnpm --filter @memry/i18n test main/index
```

Expected: FAIL — "Cannot find module './index'".

3. **Implement `packages/i18n/src/main/index.ts`**:

```ts
import i18next, { type i18n as I18nInstance } from 'i18next'
import ICU from 'i18next-icu'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE
} from '../shared/config'
import { RESOURCES } from '../locales'

interface CreateMainI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the Electron main process.
 *
 * Synchronous resource loading: all namespaces for all SUPPORTED_LOCALES
 * are bundled into the main-process JS bundle via the static RESOURCES
 * import. No filesystem I/O, no async race with menu construction.
 */
export async function createMainI18n(
  options: CreateMainI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance.use(ICU).init({
    lng: options.locale,
    fallbackLng: FALLBACK_LOCALE,
    ns: I18N_NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    resources: RESOURCES,
    interpolation: {
      escapeValue: false // main process renders no HTML
    },
    initImmediate: false // synchronous init
  })
  return instance
}

export type { I18nInstance }
```

4. **Run test to verify it passes**:

```bash
pnpm --filter @memry/i18n test main/index
```

Expected: 4 tests pass.

5. **Commit**:

```bash
git add packages/i18n/src/main/index.ts packages/i18n/src/main/index.test.ts
git commit -m "feat(i18n): add main-process i18next instance factory"
```

## Exit criteria

- [ ] `main/index.test.ts` exists with 4 tests
- [ ] `main/index.ts` exists with `createMainI18n` and `I18nInstance` exports
- [ ] All tests pass
- [ ] One commit

## Skills to use

- **`superpowers:test-driven-development`** — required
- **`superpowers:verification-before-completion`** — confirm tests pass

## Report back

```
✅ Task 10 complete.
Commit SHA: <abbrev>
Tests: 4 pass
Next: Task 11 (tighten GeneralSettings.language)
```
