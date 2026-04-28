# Task 12: Migrate `aria-label="Search"` instances

> **Plan:** Task 12 (Migrate `aria-label="Search"` Instances)
> **Depends on:** Task 01 (en/common.json has `action.search`)
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                                              # ../memry-i18n-phase-b
git status                                                                                       # clean
grep -n 'aria-label="Search"' apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx
grep -n 'aria-label="Search"' apps/desktop/src/renderer/src/components/window-controls.tsx
```

Expected: one match per file (around line 116 / 39 respectively).

## Your job

Replace `aria-label="Search"` in two files with `aria-label={t('common:action.search')}`. Screen readers will hear the localized term.

## Steps

1. **Edit `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx`:**

Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the component:

```ts
const { t } = useT('common')
```

Replace `aria-label="Search"` with `aria-label={t('action.search')}`.

2. **Edit `apps/desktop/src/renderer/src/components/window-controls.tsx`:**

Same pattern: add import, add hook in the component, replace `aria-label="Search"` with `aria-label={t('action.search')}`.

3. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

4. Smoke-test in DevTools:

```bash
pnpm dev
```

In the running app:
- Open DevTools → Elements
- Find the search button (calendar toolbar or window control)
- Inspect: `aria-label` reads "Search"
- Switch locale to Türkçe → re-inspect → `aria-label` reads "Ara"

5. Commit:

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx apps/desktop/src/renderer/src/components/window-controls.tsx
git commit -m "feat(i18n): migrate aria-label='Search' to common.action.search"
```

## Exit criteria

- [ ] Both files use `t('action.search')` for `aria-label`
- [ ] `pnpm typecheck:web` passes
- [ ] Manual DevTools verification: aria-label flips en ↔ tr
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — surgical attribute change only.

## Report back

```
✅ Task 12 complete.
Commit SHA: <abbrev>
ARIA labels migrated: 2 files
Next: Task 13 (column-selector ICU plural)
```
