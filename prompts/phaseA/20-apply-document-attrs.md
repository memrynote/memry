# Task 20: Implement `applyLocaleToDocument()` helper

> **Plan:** Task 20 (Implement `applyLocaleToDocument` Helper)
> **Depends on:** Task 19 (renderer barrel exists)
> **Dependents:** Task 21 (renderer boot calls this)

## Pre-flight check

```bash
pwd                                                       # ../memry-i18n-phase-a
git status                                                # clean
ls packages/i18n/src/renderer/index.ts                    # exists from Task 19
```

## Your job

Pure function that mutates `<html lang>` and `<html dir>` based on a locale. Called once at boot and once per locale change. The DOM is the source of truth for direction; CSS reads `[dir="rtl"]` selectors. No React state for direction needed.

## Steps

1. **Implement `packages/i18n/src/renderer/apply-document-attrs.ts`**:

```ts
import { localeDirection } from '../shared/direction'
import type { Locale } from '../shared/config'

/**
 * Sets <html lang> and <html dir> based on the active locale. Runs once
 * at boot and once per locale change. The DOM is the source of truth
 * for direction; CSS reads it via [dir="rtl"] selectors.
 */
export function applyLocaleToDocument(locale: Locale): void {
  const html = document.documentElement
  html.setAttribute('lang', locale)
  html.setAttribute('dir', localeDirection(locale))
}
```

2. **Update the renderer barrel** — append to `packages/i18n/src/renderer/index.ts`:

```ts
export { applyLocaleToDocument } from './apply-document-attrs'
```

3. **Run typecheck**:

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

4. **Commit**:

```bash
git add packages/i18n/src/renderer/apply-document-attrs.ts packages/i18n/src/renderer/index.ts
git commit -m "feat(i18n): add applyLocaleToDocument helper"
```

## Exit criteria

- [ ] `apply-document-attrs.ts` exists
- [ ] Re-exported from renderer barrel
- [ ] Typecheck passes
- [ ] One commit

## Skills to use

None.

## Report back

```
✅ Task 20 complete.
Commit SHA: <abbrev>
Typecheck: passes
Next: Task 21 (renderer boot + preload bridge)
```
