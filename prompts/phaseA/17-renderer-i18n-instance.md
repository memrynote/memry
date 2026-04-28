# Task 17: Implement `createRendererI18n()` factory (TDD)

> **Plan:** Task 17 (Implement Renderer i18next Instance)
> **Depends on:** Task 10 (main i18n exists; we mirror the pattern), Task 08 (resources exist)
> **Dependents:** Tasks 18, 19, 20, 21 (provider, hooks, doc-attrs, boot)

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/main/index.ts                        # main-process counterpart exists
```

## Your job

Mirror `createMainI18n` for the renderer process: same i18next setup, but adds the `initReactI18next` plugin so React components subscribe to language changes.

## Steps

1. **Write the test** — `packages/i18n/src/renderer/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createRendererI18n } from './index'

describe('createRendererI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a settings string', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('settings:general.language.label')).toBe('Dil')
  })

  it('changeLanguage works', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    await i18n.changeLanguage('ar')
    expect(i18n.language).toBe('ar')
  })
})
```

2. **Run test to verify it fails**:

```bash
pnpm --filter @memry/i18n test renderer/index
```

Expected: FAIL — module not found.

3. **Implement `packages/i18n/src/renderer/index.ts`**:

```ts
import i18next, { type i18n as I18nInstance } from 'i18next'
import ICU from 'i18next-icu'
import { initReactI18next } from 'react-i18next'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE
} from '../shared/config'
import { RESOURCES } from '../locales'

interface CreateRendererI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the renderer (browser context).
 *
 * Resources are bundled eagerly into the renderer JS bundle. For Phase A
 * with three locales × eight tiny namespaces, the size cost is trivial
 * (under 10KB gzipped). When string volume grows, swap to lazy loading
 * via i18next-resources-to-backend with namespace splitting.
 */
export async function createRendererI18n(
  options: CreateRendererI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      resources: RESOURCES,
      interpolation: { escapeValue: false }, // React already escapes
      react: { useSuspense: false } // we boot before mounting <App/>
    })
  return instance
}

export type { I18nInstance }
```

4. **Run test**:

```bash
pnpm --filter @memry/i18n test renderer/index
```

Expected: 3 tests pass.

5. **Commit**:

```bash
git add packages/i18n/src/renderer/index.ts packages/i18n/src/renderer/index.test.ts
git commit -m "feat(i18n): add renderer-process i18next instance factory"
```

## Exit criteria

- [ ] `renderer/index.test.ts` exists with 3 tests
- [ ] `renderer/index.ts` exists exporting `createRendererI18n` and `I18nInstance`
- [ ] All tests pass
- [ ] One commit

## Skills to use

- **`superpowers:test-driven-development`** — required
- **`superpowers:verification-before-completion`** — confirm tests pass

## Report back

```
✅ Task 17 complete.
Commit SHA: <abbrev>
Tests: 3 pass
Next: Task 18 (<I18nProvider>)
```
