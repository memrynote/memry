# Task 13: Migrate "N notes" pluralization in `column-selector.tsx`

> **Plan:** Task 13 (Migrate "N notes" Pluralization in `column-selector.tsx`)
> **Depends on:** Tasks 01–04 (en/common.json has `count.note` ICU plural; ICU verified working)
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                                              # ../memry-i18n-phase-b
git status                                                                                       # clean
grep -n 'note\${' apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx
```

Expected match around line 207:

```ts
subtitle: `${prop.usageCount} note${prop.usageCount !== 1 ? 's' : ''}`,
```

## Your job

Replace the ad-hoc `note${count !== 1 ? 's' : ''}` template with `t('common:count.note', { count })`. The ICU plural picks the right CLDR form for the active locale.

## Steps

1. Edit `apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx`. Add the import (skip if `useT` is already imported elsewhere in the file):

```ts
import { useT } from '@memry/i18n/renderer'
```

2. Inside the component (or wherever the `subtitle` is computed), add (skip if already present):

```ts
const { t } = useT('common')
```

If the `subtitle` is computed inside a `.map()` or a memoized value outside the React render tree, the hook must be called at the React component level — pull `t` from the outer scope. Re-read the surrounding 30 lines if unsure.

3. Replace the template-literal subtitle with:

```ts
subtitle: t('count.note', { count: prop.usageCount }),
```

4. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes. The `count: prop.usageCount` matches the ICU `{count, plural, ...}` parameter named `count`.

5. Smoke-test:

```bash
pnpm dev
```

Open Folder view → Column selector. Subtitles should read "5 notes", "1 note", "0 notes" depending on usage count.

Switch to Türkçe → re-open → "5 not", "1 not" (Turkish has no plural-s; both forms are the same word — that's correct).

Switch to Arabic → re-open → "5 ملاحظات", "ملاحظة واحدة", etc.

6. Commit:

```bash
git add apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx
git commit -m "feat(i18n): migrate column-selector usage count to ICU plural"
```

## Exit criteria

- [ ] `subtitle` uses `t('count.note', { count: prop.usageCount })`
- [ ] No ad-hoc `note${...}` pattern remains in the file
- [ ] `pnpm typecheck:web` passes
- [ ] Manual smoke: counts render correctly in en + tr + ar
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — surgical change. If the hook placement is awkward (computed outside React tree), pause and re-read; do not refactor more than necessary.

## Report back

```
✅ Task 13 complete.
Commit SHA: <abbrev>
ICU plural migration: 1 file (count.note)
Smoke: ✅ flips correctly in en/tr/ar
Next: Task 14 (extend e2e)
```
