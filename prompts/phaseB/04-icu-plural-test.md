# Task 04: TDD unit test for ICU pluralization across en/tr/ar

> **Plan:** Task 4 (Verify ICU Pluralization Works in All Three Locales)
> **Depends on:** Tasks 01–03 (all three locales have populated `count.*` keys)
> **Dependents:** Task 06 (uses `count.itemDelete`); Tasks 13, 15

## Pre-flight check

```bash
pwd                                                                   # ../memry-i18n-phase-b
git status                                                            # clean
ls packages/i18n/src/main/index.ts                                    # confirm Phase A's createMainI18n exists
grep -q "use(ICU)" packages/i18n/src/main/index.ts && echo "ICU wired"    # confirm i18next-icu is .use'd
```

## Your job

This is the first time `i18next-icu` is exercised by real plural keys (`count.item`, `count.note`, etc.). Add a unit test that verifies plural selection works correctly across en (one/other), tr (no plural -s), and ar (six CLDR categories).

## Steps

1. Create `packages/i18n/src/shared/icu-plural.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMainI18n } from '../main'

describe('ICU pluralization', () => {
  describe('English', () => {
    it('uses "one" form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 item')
    })

    it('uses "other" form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('0 items')
    })

    it('uses "other" form for count=5', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.note', { count: 5 })).toBe('5 notes')
    })
  })

  describe('Turkish', () => {
    it('produces same output for one and other (no plural -s in Turkish)', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 öğe')
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 öğe')
    })

    it('translates note correctly', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.note', { count: 3 })).toBe('3 not')
    })
  })

  describe('Arabic', () => {
    it('uses zero form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('لا توجد عناصر')
    })

    it('uses one form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('عنصر واحد')
    })

    it('uses two form for count=2', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 2 })).toBe('عنصران')
    })

    it('uses few form for count=5', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // few = 3-10 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 عناصر')
    })

    it('uses many form for count=11', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // many = 11-99 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 11 })).toBe('11 عنصراً')
    })
  })
})
```

2. Run the test:

```bash
pnpm --filter @memry/i18n test icu-plural
```

Expected: **all 10 tests pass** because Tasks 01–03 already wrote the ICU keys and Phase A wired the plugin.

If any fail, debug:
- "key not found" → re-verify JSON syntax in en/tr/ar `common.json`
- "expected '5 items' got '{count} items'" → ICU plugin not applied; check `createMainI18n` calls `.use(ICU)` (Phase A Task 9)
- Arabic plural categories don't match → quick sanity-check via `node -e "console.log(new Intl.PluralRules('ar').select(11))"` (must print `'many'`)

3. Commit:

```bash
git add packages/i18n/src/shared/icu-plural.test.ts
git commit -m "test(i18n): verify ICU pluralization across en/tr/ar"
```

## Exit criteria

- [ ] Test file exists with 10+ test cases
- [ ] All tests pass
- [ ] No new dependencies added (uses existing Vitest + Phase A's createMainI18n)
- [ ] One commit created

## Skills to use

`superpowers:test-driven-development` if any test fails on first run — diagnose before patching.

## Report back

```
✅ Task 04 complete.
Commit SHA: <abbrev>
Tests: 10/10 passing (en: 3, tr: 2, ar: 5)
ICU plurals confirmed working for all 3 locales
Next: Task 05 (migrate unsaved-changes-dialog)
```
