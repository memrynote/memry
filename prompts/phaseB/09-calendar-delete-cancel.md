# Task 09: Migrate `calendar/delete-calendar-event-dialog.tsx` Cancel button

> **Plan:** Task 9 (Migrate `calendar/delete-calendar-event-dialog.tsx` Cancel Button)
> **Depends on:** Task 01
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                                              # ../memry-i18n-phase-b
git status                                                                                       # clean
grep -n "AlertDialogCancel\|Cancel<" apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx
```

## Your job

Replace the Cancel button label in `calendar/delete-calendar-event-dialog.tsx` with `t('common:button.cancel')`. **Do NOT** migrate the title, body, or feature-specific Delete-event buttons — those go in Phase C calendar namespace.

## Steps

1. Add the import at the top of `apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx`:

```ts
import { useT } from '@memry/i18n/renderer'
```

2. Inside the component function:

```ts
const { t } = useT('common')
```

3. Replace `<AlertDialogCancel>Cancel</AlertDialogCancel>` with `<AlertDialogCancel>{t('button.cancel')}</AlertDialogCancel>`.

4. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

5. Commit:

```bash
git add apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx
git commit -m "feat(i18n): migrate calendar delete dialog Cancel button"
```

## Exit criteria

- [ ] Cancel button uses `t('button.cancel')`
- [ ] Title, body, and Delete-event buttons unchanged
- [ ] `pnpm typecheck:web` passes
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — surgical change.

## Report back

```
✅ Task 09 complete.
Commit SHA: <abbrev>
Cancel button migrated: 1
Next: Task 10 (Loading… in folder-view)
```
