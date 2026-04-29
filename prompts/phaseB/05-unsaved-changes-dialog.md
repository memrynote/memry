# Task 05: Migrate `tabs/unsaved-changes-dialog.tsx`

> **Plan:** Task 5 (Migrate `tabs/unsaved-changes-dialog.tsx`)
> **Depends on:** Tasks 01–04 (vocabulary in place, ICU verified)
> **Dependents:** Task 14 (e2e may use this dialog), Task 15

## Pre-flight check

```bash
pwd                                                                              # ../memry-i18n-phase-b
git status                                                                       # clean
cat apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx     # read existing
```

Identify three button labels (Save / Discard / Cancel — actual text may vary). Note the imports and the props shape.

## Your job

Migrate three universal-button labels to `t('common:button.{save,discard,cancel}')`. Validates that `useT('common')` returns translated strings and re-renders on `changeLanguage`. **Buttons only** — do NOT translate the dialog title or description (those are feature-specific copy, deferred to Phase C).

## Steps

1. Add the import at the top of `apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx`:

```ts
import { useT } from '@memry/i18n/renderer'
```

2. Inside the component function (above the `return`):

```ts
const { t } = useT('common')
```

3. Replace literal strings in JSX:

| Before | After |
|---|---|
| `>Save<` | `>{t('button.save')}<` |
| `>Discard<` | `>{t('button.discard')}<` |
| `>Cancel<` | `>{t('button.cancel')}<` |

The exact JSX shape varies — likely uses `<AlertDialogAction>`, `<AlertDialogCancel>`, and a custom Save button. Match the existing structure; only the *visible label* changes.

**Do NOT** translate the dialog title or description body — those are feature-specific (Phase C tabs).

4. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes. If it fails with "Property 'button.discard' does not exist", re-verify Task 01's `en/common.json` has `discard`.

5. Run unit tests if any exist for this component:

```bash
pnpm --filter @memry/desktop test unsaved-changes-dialog
```

Expected: passes (existing tests asserting "Save" still pass — default locale is English). If a snapshot test fails because the rendered output is identical but assertion was on literal text, update the assertion.

6. Smoke-test in the running app:

```bash
pnpm dev
```

Trigger the dialog (open a note, modify, attempt to close the tab):
- Buttons read "Save" / "Discard" / "Cancel" in English ✅
- Switch to Türkçe via Settings → re-trigger → buttons read "Kaydet" / "Vazgeç" / "İptal" ✅

7. Commit:

```bash
git add apps/desktop/src/renderer/src/components/tabs/unsaved-changes-dialog.tsx
git commit -m "feat(i18n): migrate unsaved-changes dialog buttons to common namespace"
```

## Exit criteria

- [ ] Three button labels use `t('button.{save,discard,cancel}')`
- [ ] Title and description body unchanged
- [ ] `pnpm typecheck:web` passes
- [ ] Existing tests pass
- [ ] Manual smoke: buttons flip on language change
- [ ] One commit created

## Skills to use

`superpowers:rigorous-coding` — only the visible labels change; preserve all other behavior (handlers, keyboard shortcuts, accessibility props).

## Report back

```
✅ Task 05 complete.
Commit SHA: <abbrev>
Strings migrated: 3 (Save / Discard / Cancel)
Smoke: ✅ buttons flip en ↔ tr
Next: Task 06 (bulk delete + ICU plural)
```
