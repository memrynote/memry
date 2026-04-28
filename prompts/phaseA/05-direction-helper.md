# Task 05: Implement `localeDirection` helper (TDD)

> **Plan:** Task 4 (Implement `shared/direction.ts` — TDD)
> **Depends on:** Task 04 (`config.ts` exists)
> **Dependents:** Tasks 09, 17, 19, 20, 25 (anyone needing `'ltr' | 'rtl'`)

## Pre-flight check

```bash
pwd                                                  # ../memry-i18n-phase-a
git status                                           # clean
ls packages/i18n/src/shared/config.ts                # exists from Task 04
```

## Your job

Write a single-line helper `localeDirection(locale: string): 'ltr' | 'rtl'` that wraps `Intl.Locale.textInfo.direction`. Test-first per memry's TDD discipline.

## Steps

1. **Write the failing test.** Create `packages/i18n/src/shared/direction.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { localeDirection } from './direction'

describe('localeDirection', () => {
  it('returns ltr for English', () => {
    expect(localeDirection('en')).toBe('ltr')
  })

  it('returns ltr for Turkish', () => {
    expect(localeDirection('tr')).toBe('ltr')
  })

  it('returns rtl for Arabic', () => {
    expect(localeDirection('ar')).toBe('rtl')
  })

  it('returns rtl for Hebrew (forward-compat for future locales)', () => {
    expect(localeDirection('he')).toBe('rtl')
  })

  it('returns ltr for unknown locale (Intl default behavior)', () => {
    expect(localeDirection('xx')).toBe('ltr')
  })
})
```

2. **Run the test to verify it fails:**

```bash
pnpm --filter @memry/i18n test direction.test.ts
```

Expected: FAIL — "Cannot find module './direction'".

3. **Implement `packages/i18n/src/shared/direction.ts`:**

```ts
/**
 * Returns the writing direction for a locale using `Intl.Locale.textInfo`.
 * Built into Electron 39 (Chromium 119+ / V8 12.0). No fallback table —
 * the platform owns the locale-direction mapping.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return new Intl.Locale(locale).textInfo.direction
}
```

4. **Run the test to verify it passes:**

```bash
pnpm --filter @memry/i18n test direction.test.ts
```

Expected: 5 tests pass.

5. **Commit:**

```bash
git add packages/i18n/src/shared/direction.ts packages/i18n/src/shared/direction.test.ts
git commit -m "feat(i18n): add localeDirection helper via Intl.Locale.textInfo"
```

## Exit criteria

- [ ] `direction.test.ts` exists with 5 tests
- [ ] `direction.ts` exists with `localeDirection()` export
- [ ] All 5 tests pass
- [ ] One commit created

## Skills to use

- **`superpowers:test-driven-development`** — required, this is a TDD task
- **`superpowers:verification-before-completion`** — confirm tests pass before claiming done

## Report back

```
✅ Task 05 complete.
Commit SHA: <abbrev>
Tests: 5 pass (direction.test.ts)
Next: Task 06 (i18next type augmentation)
```
