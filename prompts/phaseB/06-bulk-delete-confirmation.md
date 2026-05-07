# Task 06: Migrate `bulk/delete-confirmation-dialog.tsx` with ICU plural

> **Plan:** Task 6 (Migrate `bulk/delete-confirmation-dialog.tsx` with ICU Plural)
> **Depends on:** Tasks 01–04
> **Dependents:** Task 14 (e2e), Task 15

## Pre-flight check

```bash
pwd                                                                                    # ../memry-i18n-phase-b
git status                                                                             # clean
cat apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx       # read existing
```

Note the two strings to migrate (line numbers approximate):

- ~65: `<AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>` — _migrate_
- ~67: `Delete {itemCount} item{itemCount !== 1 ? 's' : ''}` — _migrate via `count.itemDelete`_

The dialog **title** ("Delete N items?") and **description body** ("These items will be removed from your inbox…") **stay English** — those are inbox-specific copy (Phase C).

## Your job

First migration to exercise ICU pluralization end-to-end. Add a composite `count.itemDelete` ICU key (verb + count, locale-controlled word order) to all three `common.json` files, then migrate the Cancel button and the Delete-with-count action button. Add a component test asserting the plural renders correctly in en + tr.

## Steps

1. Add `count.itemDelete` to all three `common.json` files (inside the existing `count` object):

**`packages/i18n/src/locales/en/common.json`:**

```json
"itemDelete": "{count, plural, one {Delete # item} other {Delete # items}}"
```

**`packages/i18n/src/locales/tr/common.json`:**

```json
"itemDelete": "{count, plural, one {# öğeyi sil} other {# öğeyi sil}}"
```

(Turkish word order: object before verb. "Sil" = delete; "öğeyi" = the item, accusative.)

**`packages/i18n/src/locales/ar/common.json`:**

```json
"itemDelete": "{count, plural, zero {حذف العناصر} one {حذف عنصر واحد} two {حذف عنصرين} few {حذف # عناصر} many {حذف # عنصراً} other {حذف # عنصر}}"
```

(Arabic VSO order: verb first.)

2. Edit `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx`. Add the import:

```ts
import { useT } from '@memry/i18n/renderer'
```

3. Inside the component function, near the existing hooks (above the `useEffect`):

```ts
const { t } = useT('common')
```

4. Replace the Cancel button:

```tsx
<AlertDialogCancel onClick={onCancel}>{t('button.cancel')}</AlertDialogCancel>
```

5. Replace the Delete action button label (preserve the `<AlertDialogAction>` wrapper, classNames, onClick — only the text changes):

```tsx
<AlertDialogAction onClick={onConfirm} className="bg-red-500 text-white hover:bg-red-600">
  {t('count.itemDelete', { count: itemCount })}
</AlertDialogAction>
```

The `count.itemDelete` ICU key handles the entire "Delete N items" composition — never concatenate "Delete" + count manually.

6. Run typecheck:

```bash
pnpm typecheck:web
```

Expected: passes.

7. Add a component test at `apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { DeleteConfirmationDialog } from './delete-confirmation-dialog'

describe('DeleteConfirmationDialog (i18n)', () => {
  let i18nEn: I18nInstance
  let i18nTr: I18nInstance

  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
    i18nTr = await createRendererI18n({ locale: 'tr' })
  })

  it('renders English Cancel + "Delete 5 items" for itemCount=5', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    expect(screen.getByText('Delete 5 items')).toBeInTheDocument()
  })

  it('renders English "Delete 1 item" (singular) for itemCount=1', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={1}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Delete 1 item')).toBeInTheDocument()
  })

  it('renders Turkish "İptal" + "5 öğeyi sil" when locale is tr', () => {
    render(
      <I18nextProvider i18n={i18nTr}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('İptal')).toBeInTheDocument()
    expect(screen.getByText('5 öğeyi sil')).toBeInTheDocument()
  })
})
```

If `@testing-library/react` is not yet a dev dep on `apps/desktop`, install it:

```bash
pnpm --filter @memry/desktop add -D @testing-library/react @testing-library/jest-dom
```

(Search the existing tree first — Memry likely already uses Testing Library since several `*.test.tsx` files exist. If yes, skip the install.)

8. Run the new test:

```bash
pnpm --filter @memry/desktop test delete-confirmation-dialog
```

Expected: 3 tests pass. If the dialog renders zero buttons in jsdom (Radix portals to document.body), `screen.getByText` queries the whole document — should still find them. If still failing, double-check `isOpen={true}`.

9. Commit:

```bash
git add packages/i18n/src/locales/en/common.json packages/i18n/src/locales/tr/common.json packages/i18n/src/locales/ar/common.json apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.tsx apps/desktop/src/renderer/src/components/bulk/delete-confirmation-dialog.test.tsx
git commit -m "feat(i18n): migrate bulk delete dialog buttons + ICU itemDelete key"
```

## Exit criteria

- [ ] `count.itemDelete` added to en/tr/ar JSONs
- [ ] Cancel button uses `t('button.cancel')`
- [ ] Delete button uses `t('count.itemDelete', { count })`
- [ ] Title and description body unchanged
- [ ] Component test passes (3 cases)
- [ ] `pnpm typecheck:web` passes
- [ ] One commit (or two if testing-library install creates a separate lockfile commit)

## Skills to use

`superpowers:test-driven-development` for the component test.

## Report back

```
✅ Task 06 complete.
Commit SHA: <abbrev>
Strings migrated: Cancel + ICU "Delete N items"
ICU key added: count.itemDelete (en/tr/ar)
Component test: 3/3 passing
Next: Task 07 (note-tree-dialogs Cancel)
```
