# Task 07: Migrate `note-tree-dialogs.tsx` Cancel button

> **Plan:** Task 7 (Migrate `note-tree-dialogs.tsx` Cancel Button)
> **Depends on:** Task 01 (en/common.json has `button.cancel`)
> **Dependents:** Task 15

## Pre-flight check

```bash
pwd                                                                            # ../memry-i18n-phase-b
git status                                                                     # clean
grep -n "AlertDialogCancel\|Cancel<" apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx
```

## Your job

Replace the Cancel button label(s) in `note-tree-dialogs.tsx` with `t('common:button.cancel')`. **Do NOT migrate** the title (`Delete Folder`, `Delete Note`, `Delete N Items`), the body text, or the `Deleting...` spinner label — those are tree-feature-specific and go in Phase C notes namespace.

## Steps

1. Add the import at the top of `apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx`:

```ts
import { useT } from '@memry/i18n/renderer'
```

2. Inside the `NoteTreeDeleteDialog` component (and any other component in this file that has a Cancel button), add:

```ts
const { t } = useT('common')
```

3. Replace each `<AlertDialogCancel>Cancel</AlertDialogCancel>` with `<AlertDialogCancel>{t('button.cancel')}</AlertDialogCancel>`.

If the file has multiple components defining their own Cancel buttons, repeat for each. If only one, only replace the one.

4. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

5. Smoke-test:

```bash
pnpm dev
```

In the app, trigger the note-tree delete dialog (right-click a folder or note → Delete). Switch locale to Türkçe → reopen the dialog → Cancel reads "İptal".

6. Commit:

```bash
git add apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx
git commit -m "feat(i18n): migrate note-tree delete dialog Cancel button"
```

## Exit criteria

- [ ] Every `<AlertDialogCancel>Cancel</AlertDialogCancel>` in the file uses `t('button.cancel')`
- [ ] Title, body, and `Deleting...` spinner unchanged
- [ ] `pnpm typecheck:web` passes
- [ ] Manual smoke: Cancel flips on language change
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — surgical change, only the Cancel label.

## Report back

```
✅ Task 07 complete.
Commit SHA: <abbrev>
Cancel buttons migrated: <N>
Next: Task 08 (task-delete Cancel)
```
