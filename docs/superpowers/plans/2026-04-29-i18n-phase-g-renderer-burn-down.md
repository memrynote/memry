# i18n Phase G — Renderer Hardcoded String Burn-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate ~120 user-facing English strings in the renderer that the Phase E ESLint rule (`i18n/no-jsx-text-literals`) cannot detect — toast calls, `extractErrorMessage` fallbacks, conditional ternaries inside JSX expressions, and string-attribute literals — so that switching to `tr` / `ar` produces no leaking English in everyday flows (delete, undo, save, sync, reminders, recurrence labels).

**Architecture:** No new packages, no new IPC, no new namespaces unless mid-stream a clear gap appears. Phase G extends the existing `common.json`, `notes.json`, `tasks.json`, `inbox.json` namespaces with new keys (mostly `*.toast.*`, `*.state.*`, `*.recurrence.*`) and rewrites string literals in ~25 renderer files to `t()` / `t('common:…')`. Pure-utility modules (`lib/repeat-utils.ts`) accept `t` as a parameter rather than importing the i18n instance, keeping them React-free.

**Tech Stack:** React 19, `@memry/i18n/renderer` (`useT(namespace)`), `react-i18next` v15, Vitest, Playwright, ESLint 9 flat config.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phases A–F merged. Verify by running `pnpm i18n:check` (must pass with zero failures).

**Out of scope:**
- New translations beyond the English source. `tr/*.json` and `ar/*.json` get the new keys appended as empty `{}` only when the namespace is otherwise empty; if the namespace already has entries, the new English keys are added unfilled and rely on the i18next fallback chain. Translation content is a separate workstream.
- Main-process strings (vault picker, export dialogs, reminder notifications, IPC error responses) — Phase H owns those.
- Expanding the ESLint rule to catch the patterns this phase migrates — Phase I owns that.
- Touching the `phaseF.*` orphan keys in `common.json` — clean-up tracked separately.
- BlockNote editor internals.

---

## Worktree Setup

Per memry's MEMORY.md: *"implement plan changes in git worktrees, not directly on current branch."*

- [ ] **Step 1: Create worktree off `main`**

```bash
git worktree add ../memry-i18n-phase-g -b feature/i18n-phase-g
cd ../memry-i18n-phase-g
```

- [ ] **Step 2: Verify Phase F baseline**

```bash
pnpm install
pnpm i18n:check
pnpm i18n:codemod:todo:check
```

Expected:
- `i18n:check`: `ok: i18n check passed`, no missing English keys.
- `codemod:todo:check`: `0 file(s) need updates`.

If either fails, stop and rebase onto a branch where Phase F is fully merged.

- [ ] **Step 3: Confirm working tree clean**

```bash
git status
```

Expected: clean.

---

## Task 1: Extend `common.json` with Universal Toast and Recurrence Keys

**Files:**
- Modify: `packages/i18n/src/locales/en/common.json`

This task is purely additive — keeps every existing key.

- [ ] **Step 1: Add `toast`, `recurrence`, and `relative` sections**

Open `packages/i18n/src/locales/en/common.json`. Insert the following keys between the existing `count` block and `phaseF` block:

```json
"toast": {
  "actionFailed": "Action failed",
  "nothingToUndo": "Nothing to undo",
  "undone": "Undone: {description}",
  "undoFailed": "Failed to undo action",
  "copied": "Copied",
  "copyFailed": "Failed to copy"
},
"recurrence": {
  "everyDay": "Every day",
  "everyNDays": "{count, plural, one {Every day} other {Every # days}}",
  "everyWeek": "Every week",
  "everyNWeeks": "{count, plural, one {Every week} other {Every # weeks}}",
  "everyWeekday": "Every weekday",
  "everyNWeeksOnWeekdays": "{count, plural, one {Every weekday} other {Every # weeks on weekdays}}",
  "everyWeekend": "Every weekend",
  "everyNWeeksOnWeekends": "{count, plural, one {Every weekend} other {Every # weeks on weekends}}",
  "everyWeekOnDays": "Every week on {days}",
  "everyNWeeksOnDays": "{count, plural, one {Every week on {days}} other {Every # weeks on {days}}}",
  "everyMonth": "Every month",
  "everyNMonths": "{count, plural, one {Every month} other {Every # months}}",
  "everyMonthOnDay": "Every month on the {day}{suffix}",
  "everyNMonthsOnDay": "{count, plural, one {Every month on the {day}{suffix}} other {Every # months on the {day}{suffix}}}",
  "everyMonthOnWeekDay": "Every month on the {week} {day}",
  "everyNMonthsOnWeekDay": "{count, plural, one {Every month on the {week} {day}} other {Every # months on the {week} {day}}}",
  "everyYear": "Every year",
  "everyNYears": "{count, plural, one {Every year} other {Every # years}}",
  "repeats": "Repeats"
}
```

The `relative` and other sections from `phaseF.*` stay where they are; do not move them.

- [ ] **Step 2: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/common.json', 'utf8'))" && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes. The augmented type from `shared/types.ts` now includes `common.toast.*` and `common.recurrence.*`.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): add common toast + recurrence keys for phase G burn-down"
```

---

## Task 2: Migrate `use-undo.ts` (4 hardcoded toasts → common namespace)

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-undo.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-undo.test.ts` (create if absent; check for existing first)

The undo hook fires four toast strings. They are all universal verbs/states; the `common.toast.*` keys added in Task 1 cover them.

- [ ] **Step 1: Read the current shape**

```bash
grep -n "toast\." apps/desktop/src/renderer/src/hooks/use-undo.ts
```

Expected matches around lines 173, 179, 184 (current shape):

```ts
toast.info('Nothing to undo')
toast.success(`Undone: ${entry.description}`)
toast.error('Failed to undo action')
```

- [ ] **Step 2: Add `useT` import + hook**

Edit `apps/desktop/src/renderer/src/hooks/use-undo.ts`. At the top with other imports:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the `useUndoTracker` hook function, before the existing `useCallback` blocks:

```ts
const { t } = useT('common')
```

- [ ] **Step 3: Replace each toast call**

Replace the three toast calls inside the `undo` callback:

| Before | After |
|---|---|
| `toast.info('Nothing to undo')` | `toast.info(t('toast.nothingToUndo'))` |
| `` toast.success(`Undone: ${entry.description}`) `` | `toast.success(t('toast.undone', { description: entry.description }))` |
| `toast.error('Failed to undo action')` | `toast.error(t('toast.undoFailed'))` |

The `t` reference must be captured inside the `useCallback` dependency array. Update the dependency list:

```ts
const undo = useCallback((): boolean => {
  // …existing body…
}, [t])
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 5: Add a unit test (TDD-style — added after code because hook contract is tiny)**

Create `apps/desktop/src/renderer/src/hooks/use-undo.test.ts` if it does not already exist. If it does, append the new test cases.

```ts
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { toast } from 'sonner'
import { createRendererI18n, type I18nInstance } from '@memry/i18n/renderer'
import { useUndoTracker } from './use-undo'

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('useUndoTracker (i18n)', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    i18n = await createRendererI18n({ locale: 'en' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function wrapper({ children }: { children: React.ReactNode }) {
    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  }

  it('toasts "Nothing to undo" via common.toast.nothingToUndo when stack is empty', () => {
    const { result } = renderHook(() => useUndoTracker(), { wrapper })

    act(() => {
      result.current.undo()
    })

    expect(toast.info).toHaveBeenCalledWith('Nothing to undo')
  })

  it('toasts the localized "Undone: …" with the description on success', () => {
    const { result } = renderHook(() => useUndoTracker(), { wrapper })

    act(() => {
      result.current.registerUndo('Delete task', () => {})
    })
    act(() => {
      result.current.undo()
    })

    expect(toast.success).toHaveBeenCalledWith('Undone: Delete task')
  })

  it('toasts "Failed to undo action" when the undo function throws', () => {
    const { result } = renderHook(() => useUndoTracker(), { wrapper })

    act(() => {
      result.current.registerUndo('Throwy', () => {
        throw new Error('boom')
      })
    })
    act(() => {
      result.current.undo()
    })

    expect(toast.error).toHaveBeenCalledWith('Failed to undo action')
  })
})
```

- [ ] **Step 6: Run the test**

```bash
pnpm --filter @memry/desktop test use-undo
```

Expected: all three tests pass. If a test fails because the file is `.ts` not `.tsx`, rename to `use-undo.test.tsx` so JSX wrapper compiles.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-undo.ts apps/desktop/src/renderer/src/hooks/use-undo.test.tsx
git commit -m "feat(i18n): migrate use-undo toasts to common namespace"
```

---

## Task 3: Extend `tasks.json` with Bulk-Action and Undoable Toast Keys

**Files:**
- Modify: `packages/i18n/src/locales/en/tasks.json`

Tasks 4 and 5 migrate `use-bulk-actions.ts` and `use-undoable-task-actions.ts`. Both fire toast strings that are tasks-domain specific.

- [ ] **Step 1: Read current `tasks.json` shape**

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/tasks.json', 'utf8'))))"
```

Expected: top-level keys including `page`, `task`, `project`, `status`, `priority`, `filters`, `quickAdd`, `drawer`, `kanban`, `toasts`, `phaseF`.

- [ ] **Step 2: Read the existing `toasts` section so we add to it instead of creating a duplicate top-level**

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/tasks.json', 'utf8')).toasts, null, 2))" | head -40
```

- [ ] **Step 3: Add new toast keys to the existing `toasts` section**

Edit `packages/i18n/src/locales/en/tasks.json`. Inside the existing `toasts` object, append (do not duplicate keys that already exist):

```json
"deleted": "Task deleted",
"deletedSeries": "Series complete!",
"deletedNext": "Next occurrence",
"completed": "Task completed!",
"archived": "Task archived",
"undoNotAvailableForDelete": "Undo not available for delete",
"alreadyAllComplete": "All selected tasks are already complete",
"noCompletedSelected": "No completed tasks selected",
"completeFailed": "Failed to complete tasks",
"reopenFailed": "Failed to reopen tasks",
"deleteFailed": "Failed to delete tasks",
"moveFailed": "Failed to move tasks"
```

If any of these keys already exist with the same English value, skip that line (don't shadow).

- [ ] **Step 4: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/tasks.json', 'utf8'))" && echo OK
```

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales/en/tasks.json
git commit -m "feat(i18n): add tasks toast keys for bulk + undoable actions"
```

---

## Task 4: Migrate `use-bulk-actions.ts` and `use-undoable-task-actions.ts`

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-bulk-actions.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/use-undoable-task-actions.ts`

- [ ] **Step 1: Locate the toast calls**

```bash
grep -n "toast\." apps/desktop/src/renderer/src/hooks/use-bulk-actions.ts
grep -n "toast\." apps/desktop/src/renderer/src/hooks/use-undoable-task-actions.ts
grep -n "extractErrorMessage" apps/desktop/src/renderer/src/hooks/use-bulk-actions.ts
```

For each match, note the literal string. Build a `before → after` table.

- [ ] **Step 2: Migrate `use-bulk-actions.ts`**

Add at the top of the imports block:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the hook function (top-most `useBulkActions`), add:

```ts
const { t } = useT('tasks')
const { t: tCommon } = useT('common')
```

Replace toast calls. For each occurrence:

| Before | After |
|---|---|
| `toast.info('All selected tasks are already complete')` | `toast.info(t('toasts.alreadyAllComplete'))` |
| `toast.warning('No completed tasks selected')` | `toast.warning(t('toasts.noCompletedSelected'))` |
| `toast.error('Failed to complete tasks')` | `toast.error(t('toasts.completeFailed'))` |
| `toast.error('Failed to reopen tasks')` | `toast.error(t('toasts.reopenFailed'))` |
| `toast.error('Failed to delete tasks')` | `toast.error(t('toasts.deleteFailed'))` |
| `toast.error('Failed to move tasks')` | `toast.error(t('toasts.moveFailed'))` |
| `toast.error('Action failed')` | `toast.error(tCommon('toast.actionFailed'))` |

For each `extractErrorMessage(err, 'literal')`:

```ts
// Before:
extractErrorMessage(err, 'Failed to complete tasks')
// After:
extractErrorMessage(err, t('toasts.completeFailed'))
```

Update each `useCallback` dependency array to include `t` (or `tCommon`) it now references.

- [ ] **Step 3: Migrate `use-undoable-task-actions.ts`**

Same pattern. Add the imports + hooks at the top.

| Before | After |
|---|---|
| `toast.success('Task deleted')` | `toast.success(t('toasts.deleted'))` |
| `toast.success('Task completed!')` | `toast.success(t('toasts.completed'))` |
| `toast.success('Series complete!')` | `toast.success(t('toasts.deletedSeries'))` |
| `toast.info('Next occurrence')` | `toast.info(t('toasts.deletedNext'))` |
| `toast.success('Task archived')` | `toast.success(t('toasts.archived'))` |
| `toast.warning('Undo not available for delete')` | `toast.warning(t('toasts.undoNotAvailableForDelete'))` |

Update dependency arrays.

- [ ] **Step 4: Run typecheck + relevant tests**

```bash
pnpm typecheck:desktop
pnpm --filter @memry/desktop test use-bulk-actions
pnpm --filter @memry/desktop test use-undoable-task-actions
```

Expected: all pass. If a pre-existing test asserted on a literal string (`expect(...).toBe('Task deleted')`), it still passes because English is the default locale.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-bulk-actions.ts apps/desktop/src/renderer/src/hooks/use-undoable-task-actions.ts
git commit -m "feat(i18n): migrate bulk + undoable task hook toasts to tasks namespace"
```

---

## Task 5: Migrate `use-drag-handlers.ts` (mixed toast + extractErrorMessage)

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts`

- [ ] **Step 1: Locate the literals**

```bash
grep -n "toast\.\|extractErrorMessage" apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts
```

Expected hits include:
- `toast.success('Task deleted')`
- `toast.success('Task archived')`
- `toast.warning('Undo not available for delete')`
- `extractErrorMessage(result.error, 'Failed to move tasks')`

- [ ] **Step 2: Migrate**

Add imports:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the hook:

```ts
const { t } = useT('tasks')
```

Replace each match using the keys added in Task 3:

| Before | After |
|---|---|
| `toast.success('Task deleted')` | `toast.success(t('toasts.deleted'))` |
| `toast.success('Task archived')` | `toast.success(t('toasts.archived'))` |
| `toast.warning('Undo not available for delete')` | `toast.warning(t('toasts.undoNotAvailableForDelete'))` |
| `extractErrorMessage(result.error, 'Failed to move tasks')` | `extractErrorMessage(result.error, t('toasts.moveFailed'))` |

Update `useCallback` dependency arrays to include `t`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts
git commit -m "feat(i18n): migrate drag-handler toasts and error fallbacks"
```

---

## Task 6: Extend `notes.json` with Note-Page Toast Keys

**Files:**
- Modify: `packages/i18n/src/locales/en/notes.json`

Task 7 migrates `pages/note.tsx`. Define the keys it needs first.

- [ ] **Step 1: Read current `notes.json` top-level keys**

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/notes.json', 'utf8'))))"
```

Confirm `page` exists. We'll extend it with a `toast` sub-section.

- [ ] **Step 2: Add a `toast` block to `page`**

Inside the `page` object in `packages/i18n/src/locales/en/notes.json`, append:

```json
"toast": {
  "cannotSaveDeleted": "Cannot save - note was deleted",
  "cannotRenameDeleted": "Cannot rename - note was deleted",
  "createLinkedFailed": "Failed to create linked note",
  "openLinkedFailed": "Failed to open linked item",
  "localOnly": "Note set to local only",
  "willSync": "Note will sync to cloud",
  "saveFailed": "Failed to save note",
  "renameFailed": "Failed to rename note"
}
```

Do not nest under `page.toast` if `page` already contains a `toast` — append to the existing one. Run a JSON inspector first if uncertain.

- [ ] **Step 3: Verify and commit**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/notes.json', 'utf8'))" && echo OK
git add packages/i18n/src/locales/en/notes.json
git commit -m "feat(i18n): add notes.page.toast keys for note page burn-down"
```

---

## Task 7: Migrate `pages/note.tsx` (8 toasts + state ternaries)

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`

- [ ] **Step 1: Locate the literals**

```bash
grep -n "toast\.\|? 'Note set" apps/desktop/src/renderer/src/pages/note.tsx
```

- [ ] **Step 2: Add imports + hook**

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the page component:

```ts
const { t } = useT('notes')
```

- [ ] **Step 3: Replace toast calls**

| Before | After |
|---|---|
| `toast.error('Cannot save - note was deleted')` | `toast.error(t('page.toast.cannotSaveDeleted'))` |
| `toast.error('Cannot rename - note was deleted')` | `toast.error(t('page.toast.cannotRenameDeleted'))` |
| `toast.error('Failed to create linked note')` | `toast.error(t('page.toast.createLinkedFailed'))` |
| `toast.error('Failed to open linked item')` | `toast.error(t('page.toast.openLinkedFailed'))` |
| `toast.success('Note set to local only')` | `toast.success(t('page.toast.localOnly'))` |
| `toast.success('Note will sync to cloud')` | `toast.success(t('page.toast.willSync'))` |
| `toast.error('Failed to save note')` | `toast.error(t('page.toast.saveFailed'))` |
| `toast.error('Failed to rename note')` | `toast.error(t('page.toast.renameFailed'))` |

- [ ] **Step 4: Replace ternary at note.tsx:654**

Search for the local-only/sync ternary:

```bash
grep -n "Note set to local only" apps/desktop/src/renderer/src/pages/note.tsx
```

Replace the ternary expression `isLocalOnly ? 'Note set to local only' : 'Note will sync to cloud'` with:

```ts
isLocalOnly ? t('page.toast.localOnly') : t('page.toast.willSync')
```

(If the ternary lives inside the toast call already replaced above, this is a no-op duplicate — confirm there are no remaining ternaries.)

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 6: Smoke-test in dev**

```bash
pnpm dev
```

Open a note. Modify it; confirm save toasts work. Delete a note while open; confirm "Cannot save / rename" toasts. Switch language to Türkçe in Settings; verify Turkish renders for these toasts (will fall back to English since `tr/notes.json` is empty `{}`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/note.tsx
git commit -m "feat(i18n): migrate note page toasts and local-only ternary"
```

---

## Task 8: Extend `notes.json` with Templates and Version-History Keys

**Files:**
- Modify: `packages/i18n/src/locales/en/notes.json`

- [ ] **Step 1: Append the keys**

In `packages/i18n/src/locales/en/notes.json`, add a new top-level section `templateEditor` (or extend the existing `templateSelector`/`templates` section if present — inspect first):

```json
"templateEditor": {
  "title": {
    "new": "New Template",
    "view": "View Template",
    "edit": "Edit Template"
  },
  "toast": {
    "nameRequired": "Template name is required",
    "created": "Template created",
    "createFailed": "Failed to create template",
    "saved": "Template saved",
    "saveFailed": "Failed to save template",
    "duplicateFailed": "Failed to duplicate template",
    "deleteFailed": "Failed to delete template"
  }
}
```

In the same file, add a new top-level `versionHistory.toast` (or extend existing `versionHistory`):

```json
"versionHistory": {
  "toast": {
    "loadPreviewFailed": "Failed to load version preview",
    "restored": "Note restored to previous version",
    "deleted": "Version deleted"
  }
}
```

And `exportDialog.toast`:

```json
"exportDialog": {
  "toast": {
    "failed": "Export failed"
  }
}
```

- [ ] **Step 2: Verify + commit**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/notes.json', 'utf8'))" && echo OK
git add packages/i18n/src/locales/en/notes.json
git commit -m "feat(i18n): add templates + version history + export toast keys"
```

---

## Task 9: Migrate `pages/template-editor.tsx` and `pages/templates.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/template-editor.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/templates.tsx`

- [ ] **Step 1: Add imports + hook to template-editor.tsx**

```ts
import { useT } from '@memry/i18n/renderer'
```

```ts
const { t } = useT('notes')
```

- [ ] **Step 2: Replace toasts in template-editor.tsx**

| Before | After |
|---|---|
| `toast.error('Template name is required')` | `toast.error(t('templateEditor.toast.nameRequired'))` |
| `toast.success('Template created')` | `toast.success(t('templateEditor.toast.created'))` |
| `toast.error('Failed to create template')` | `toast.error(t('templateEditor.toast.createFailed'))` |
| `toast.success('Template saved')` | `toast.success(t('templateEditor.toast.saved'))` |
| `toast.error('Failed to save template')` | `toast.error(t('templateEditor.toast.saveFailed'))` |

- [ ] **Step 3: Replace title ternary in template-editor.tsx:426**

Locate:

```bash
grep -n "isNew ? 'New Template'" apps/desktop/src/renderer/src/pages/template-editor.tsx
```

Replace:

```tsx
{isNew ? 'New Template' : isBuiltIn ? 'View Template' : 'Edit Template'}
```

with:

```tsx
{isNew
  ? t('templateEditor.title.new')
  : isBuiltIn
  ? t('templateEditor.title.view')
  : t('templateEditor.title.edit')}
```

- [ ] **Step 4: Migrate `templates.tsx`**

Same pattern: add imports + hook. Replace:

| Before | After |
|---|---|
| `toast.error('Failed to duplicate template')` | `toast.error(t('templateEditor.toast.duplicateFailed'))` |
| `toast.error('Failed to delete template')` | `toast.error(t('templateEditor.toast.deleteFailed'))` |

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add apps/desktop/src/renderer/src/pages/template-editor.tsx apps/desktop/src/renderer/src/pages/templates.tsx
git commit -m "feat(i18n): migrate template editor + templates page strings"
```

---

## Task 10: Migrate `version-history.tsx` and `export-dialog.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/version-history.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/export-dialog.tsx`

- [ ] **Step 1: Migrate version-history.tsx**

Add `import { useT } from '@memry/i18n/renderer'` and inside the component `const { t } = useT('notes')`.

| Before | After |
|---|---|
| `toast.error('Failed to load version preview')` | `toast.error(t('versionHistory.toast.loadPreviewFailed'))` |
| `toast.success('Note restored to previous version')` | `toast.success(t('versionHistory.toast.restored'))` |
| `toast.success('Version deleted')` | `toast.success(t('versionHistory.toast.deleted'))` |

- [ ] **Step 2: Migrate export-dialog.tsx**

| Before | After |
|---|---|
| `toast.error('Export failed')` | `toast.error(t('exportDialog.toast.failed'))` |

(There may be two occurrences — replace both.)

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add apps/desktop/src/renderer/src/components/note/version-history.tsx apps/desktop/src/renderer/src/components/note/export-dialog.tsx
git commit -m "feat(i18n): migrate version history + export dialog toasts"
```

---

## Task 11: Extend `notes.json` with Reminder Feedback Keys

**Files:**
- Modify: `packages/i18n/src/locales/en/notes.json`

- [ ] **Step 1: Add a `reminders.toast` section**

```json
"reminders": {
  "toast": {
    "set": "Reminder set",
    "setForHighlight": "Reminder set for highlighted text",
    "setFailed": "Failed to set reminder",
    "deleted": "Reminder deleted",
    "deleteFailed": "Failed to delete reminder",
    "dismissed": "Reminder dismissed",
    "dismissFailed": "Failed to dismiss reminder"
  }
}
```

If a `reminders` section already exists with non-toast content, nest the new `toast` object inside it.

- [ ] **Step 2: Verify + commit**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/notes.json', 'utf8'))" && echo OK
git add packages/i18n/src/locales/en/notes.json
git commit -m "feat(i18n): add notes.reminders.toast keys"
```

---

## Task 12: Migrate `use-note-reminders.ts` and `highlight-reminder-popover.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/hooks/use-note-reminders.ts`
- Modify: `apps/desktop/src/renderer/src/components/reminder/highlight-reminder-popover.tsx`

- [ ] **Step 1: Migrate use-note-reminders.ts**

Add `import { useT } from '@memry/i18n/renderer'` and `const { t } = useT('notes')`.

| Before | After |
|---|---|
| `toast.success('Reminder set')` | `toast.success(t('reminders.toast.set'))` |
| `toast.success('Reminder set for highlighted text')` | `toast.success(t('reminders.toast.setForHighlight'))` |
| `toast.error('Failed to set reminder')` | `toast.error(t('reminders.toast.setFailed'))` |
| `toast.success('Reminder deleted')` | `toast.success(t('reminders.toast.deleted'))` |
| `toast.error('Failed to delete reminder')` | `toast.error(t('reminders.toast.deleteFailed'))` |
| `toast.success('Reminder dismissed')` | `toast.success(t('reminders.toast.dismissed'))` |
| `toast.error('Failed to dismiss reminder')` | `toast.error(t('reminders.toast.dismissFailed'))` |
| `extractErrorMessage(result.error, 'Failed to set reminder')` | `extractErrorMessage(result.error, t('reminders.toast.setFailed'))` |

Update each `useCallback` dependency array to include `t`.

- [ ] **Step 2: Migrate highlight-reminder-popover.tsx**

Same imports + hook. Replace:

| Before | After |
|---|---|
| `toast.success('Reminder set for highlight')` | `toast.success(t('reminders.toast.setForHighlight'))` |
| `toast.error('Failed to set reminder')` | `toast.error(t('reminders.toast.setFailed'))` |

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add apps/desktop/src/renderer/src/hooks/use-note-reminders.ts apps/desktop/src/renderer/src/components/reminder/highlight-reminder-popover.tsx
git commit -m "feat(i18n): migrate reminder feedback toasts"
```

---

## Task 13: Migrate `pages/inbox/triage-view.tsx` and Inbox Error Fallbacks

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`

- [ ] **Step 1: Add imports + hook**

```ts
import { useT } from '@memry/i18n/renderer'
```

```ts
const { t: tCommon } = useT('common')
```

- [ ] **Step 2: Replace literals**

| Before | After |
|---|---|
| `toast.error('Action failed')` | `toast.error(tCommon('toast.actionFailed'))` |
| `extractErrorMessage(err, 'Action failed')` | `extractErrorMessage(err, tCommon('toast.actionFailed'))` |

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx
git commit -m "feat(i18n): migrate inbox triage-view error toasts"
```

---

## Task 14: Migrate `contexts/sync-context.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/contexts/sync-context.tsx`

The single hardcoded toast is "Local data export is not yet implemented" — a placeholder. Move to a settings or sync namespace key.

- [ ] **Step 1: Decide namespace**

This message is settings-domain (it appears when the user attempts a settings export action). Add to `settings.json`:

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/settings.json', 'utf8'))))"
```

If `account` or `general` exists, append a `toast` block to one of them. Otherwise add a top-level `toast` block.

In `packages/i18n/src/locales/en/settings.json`, append (or merge) this top-level block:

```json
"toast": {
  "exportNotImplemented": "Local data export is not yet implemented"
}
```

- [ ] **Step 2: Migrate the context**

Add imports + hook to `sync-context.tsx`:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside the provider component:

```ts
const { t } = useT('settings')
```

Replace `toast.info('Local data export is not yet implemented')` with `toast.info(t('toast.exportNotImplemented'))`.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add packages/i18n/src/locales/en/settings.json apps/desktop/src/renderer/src/contexts/sync-context.tsx
git commit -m "feat(i18n): migrate sync-context placeholder toast"
```

---

## Task 15: Refactor `lib/repeat-utils.ts` to Accept `t` Parameter (Recurrence Labels)

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/repeat-utils.ts`
- Update callers (every file that imports `getRepeatLabel`) — locate via grep
- Test: `apps/desktop/src/renderer/src/lib/repeat-utils.test.ts`

`repeat-utils.ts` is a pure utility module — must not depend on React. The 7+ recurrence labels become parameters of a `t` function passed in by the caller.

- [ ] **Step 1: Find all callers**

```bash
grep -rn "getRepeatLabel\|describeRepeat" apps/desktop/src/renderer/src --include="*.ts" --include="*.tsx" | head -40
```

Note every call site.

- [ ] **Step 2: Read the existing signature**

```bash
grep -n "export function" apps/desktop/src/renderer/src/lib/repeat-utils.ts | head -20
```

Identify the function name (likely `getRepeatLabel(config: RepeatConfig)` or similar) and its return shape.

- [ ] **Step 3: Define a translator type at top of `repeat-utils.ts`**

Add this just below the existing imports:

```ts
import type { TFunction } from 'i18next'

export type RepeatLabelTranslator = TFunction<'common'>
```

- [ ] **Step 4: Rewrite `getRepeatLabel` to take `t`**

Change the signature from `function getRepeatLabel(config: RepeatConfig): string` to `function getRepeatLabel(config: RepeatConfig, t: RepeatLabelTranslator): string`.

Replace each literal in the body. Mapping from current code (per audit lines 261-302):

| Current | New |
|---|---|
| `interval === 1 ? 'Every day' : \`Every ${interval} days\`` | `t('recurrence.everyNDays', { count: interval })` |
| `interval === 1 ? 'Every week' : \`Every ${interval} weeks\`` | `t('recurrence.everyNWeeks', { count: interval })` |
| `interval === 1 ? 'Every weekday' : \`Every ${interval} weeks on weekdays\`` | `t('recurrence.everyNWeeksOnWeekdays', { count: interval })` |
| `interval === 1 ? 'Every weekend' : \`Every ${interval} weeks on weekends\`` | `t('recurrence.everyNWeeksOnWeekends', { count: interval })` |
| `interval === 1 ? \`Every week on ${daysList}\` : \`Every ${interval} weeks on ${daysList}\`` | `t('recurrence.everyNWeeksOnDays', { count: interval, days: daysList })` |
| `interval === 1 ? 'Every month' : \`Every ${interval} months\`` | `t('recurrence.everyNMonths', { count: interval })` |
| `\`Every ${monthlyType === 'dayOfMonth' …}\`` (day-of-month variant) | `t('recurrence.everyNMonthsOnDay', { count: interval, day: dayOfMonth, suffix })` |
| Week-pattern variant | `t('recurrence.everyNMonthsOnWeekDay', { count: interval, week: weekText, day: dayText })` |
| `interval === 1 ? 'Every year' : \`Every ${interval} years\`` | `t('recurrence.everyNYears', { count: interval })` |
| `'Repeats'` (default) | `t('recurrence.repeats')` |

Day-of-week names (`SHORT_DAY_NAMES`, `DAY_NAMES`, `ORDINALS`) stay as English constants for now — they are date primitives that need their own dedicated migration (use `Intl.DateTimeFormat` + per-locale ordinal logic). Out of scope for this task; leave them.

- [ ] **Step 5: Update every caller**

For each grep hit from Step 1, edit the file:

1. If the caller is a React component or hook, add `const { t } = useT('common')` and pass it: `getRepeatLabel(config, t)`.
2. If the caller is itself a pure utility, push the `t` parameter up another level.

Example for a typical call site:

```tsx
// Before:
import { getRepeatLabel } from '@/lib/repeat-utils'
…
<span>{getRepeatLabel(config)}</span>

// After:
import { getRepeatLabel } from '@/lib/repeat-utils'
import { useT } from '@memry/i18n/renderer'
…
const { t } = useT('common')
…
<span>{getRepeatLabel(config, t)}</span>
```

- [ ] **Step 6: Update or create the test**

If `apps/desktop/src/renderer/src/lib/repeat-utils.test.ts` exists, update assertions to mock or call the function with a stub `t` (`(key, opts) => \`${key}\`` for shape testing, or a real `createMainI18n`/`createRendererI18n` instance for full output testing).

If not present, create a minimal test:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createRendererI18n, type I18nInstance } from '@memry/i18n/renderer'
import { getRepeatLabel } from './repeat-utils'

describe('getRepeatLabel (i18n)', () => {
  let i18n: I18nInstance
  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  it('returns "Every day" for daily/1', () => {
    expect(getRepeatLabel({ frequency: 'daily', interval: 1 }, i18n.t.bind(i18n)))
      .toBe('Every day')
  })

  it('returns "Every 3 days" for daily/3', () => {
    expect(getRepeatLabel({ frequency: 'daily', interval: 3 }, i18n.t.bind(i18n)))
      .toBe('Every 3 days')
  })

  it('returns "Every weekday" for weekly Mon-Fri', () => {
    expect(getRepeatLabel(
      { frequency: 'weekly', interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
      i18n.t.bind(i18n)
    )).toBe('Every weekday')
  })

  it('returns "Every year" for yearly/1', () => {
    expect(getRepeatLabel({ frequency: 'yearly', interval: 1 }, i18n.t.bind(i18n)))
      .toBe('Every year')
  })

  it('returns "Repeats" for unrecognized frequency', () => {
    expect(getRepeatLabel({ frequency: 'unknown' as never, interval: 1 }, i18n.t.bind(i18n)))
      .toBe('Repeats')
  })
})
```

- [ ] **Step 7: Run all relevant tests**

```bash
pnpm typecheck:desktop
pnpm --filter @memry/desktop test repeat-utils
```

Expected: passes. The typecheck will surface every caller you missed in Step 5 — fix them iteratively until typecheck is green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/repeat-utils.ts apps/desktop/src/renderer/src/lib/repeat-utils.test.ts
git add $(git diff --name-only HEAD)  # stage every caller updated above
git commit -m "feat(i18n): refactor repeat-utils to accept translator parameter"
```

---

## Task 16: Migrate JSX Ternary State Strings (Sidebar, Tabs, Tag Rename, Folder View)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/tag-rename-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-context-menu.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/folder-view.tsx`
- Modify: `packages/i18n/src/locales/en/common.json` — add `aria.expand`/`aria.collapse`, `aria.showMore`/`aria.showLess`
- Modify: `packages/i18n/src/locales/en/notes.json` — add tab pin/unpin keys (or `inbox.json` if the menu is inbox-scoped — confirm via the file's surrounding context)

- [ ] **Step 1: Add aria/state keys to `common.json`**

Inside the existing `action` block in `packages/i18n/src/locales/en/common.json`, append:

```json
"expand": "Expand",
"collapse": "Collapse",
"showMore": "+{count, plural, one {# more} other {# more}}",
"showLess": "Show less"
```

(`showMore` is intentionally an ICU plural so locales like Russian/Polish can vary it; English uses the same form for both.)

- [ ] **Step 2: Add tab pin/unpin keys to `notes.json`**

Confirm where `tab-context-menu.tsx` lives in the namespace map. Tab UI is tab-feature (renderer chrome), already partially in `common.phaseF.componentsTabs*`. Add to `common.json` instead since tabs are app-wide chrome:

```json
"tabs": {
  "pin": "Pin Tab",
  "unpin": "Unpin Tab"
}
```

- [ ] **Step 3: Migrate `sidebar-tag-list.tsx`**

Add imports + hook:

```ts
import { useT } from '@memry/i18n/renderer'
```

```ts
const { t } = useT('common')
```

Replace ternaries:

| Before | After |
|---|---|
| `aria-label={isExpanded ? 'Collapse' : 'Expand'}` | `aria-label={isExpanded ? t('action.collapse') : t('action.expand')}` |
| `{showAll ? 'Show less' : \`+${tree.length - maxVisible} more\`}` | `{showAll ? t('action.showLess') : t('action.showMore', { count: tree.length - maxVisible })}` |

- [ ] **Step 4: Migrate `tag-rename-dialog.tsx`**

```ts
const { t } = useT('common')
```

Replace `{submitting ? 'Saving...' : 'Save'}` with `{submitting ? t('state.saving') : t('button.save')}`.

- [ ] **Step 5: Migrate `tab-context-menu.tsx`**

```ts
const { t } = useT('common')
```

Replace `label: tab.isPinned ? 'Unpin Tab' : 'Pin Tab'` with `label: tab.isPinned ? t('tabs.unpin') : t('tabs.pin')`.

- [ ] **Step 6: Migrate `pages/folder-view.tsx` ternaries**

Locate (folder-view.tsx:730, 747):

```bash
grep -n "Delete Note\|Deleting\.\.\." apps/desktop/src/renderer/src/pages/folder-view.tsx
```

The folder-view UI is in `notes` namespace per the heuristic in Phase F. Confirm the file already uses `useT('notes')`; if not, add it.

For the count-based delete title (`{notesToDelete.length === 1 ? 'Delete Note' : \`Delete ${notesToDelete.length} Notes\`}`), define a new ICU plural key in `notes.json`:

```json
"page": {
  "deleteDialogTitle": "{count, plural, one {Delete Note} other {Delete # Notes}}"
}
```

Then in the JSX:

```tsx
{t('page.deleteDialogTitle', { count: notesToDelete.length })}
```

For the action button state (`{isDeleting ? 'Deleting...' : 'Delete'}`):

```tsx
{isDeleting ? tCommon('state.deleting') : tCommon('button.delete')}
```

(Bring in `const { t: tCommon } = useT('common')` if not already present.)

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck:desktop
git add packages/i18n/src/locales/en/common.json packages/i18n/src/locales/en/notes.json apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx apps/desktop/src/renderer/src/components/sidebar/tag-rename-dialog.tsx apps/desktop/src/renderer/src/components/tabs/tab-context-menu.tsx apps/desktop/src/renderer/src/pages/folder-view.tsx
git commit -m "feat(i18n): migrate JSX state ternaries (sidebar/tabs/folder-view)"
```

---

## Task 17: Sweep Remaining `extractErrorMessage` Hardcoded Fallbacks

**Files:**
- Modify: any renderer file matching `extractErrorMessage([^,]+,\s*['"\`]\w` with English fallback

The audit identified ~25 hardcoded fallbacks; Tasks 4, 5, 12, 13 covered the high-density files. This task sweeps the long tail.

- [ ] **Step 1: Re-locate all remaining literal fallbacks**

```bash
grep -rn "extractErrorMessage([^,]\+,\s*['\"\\\`]" apps/desktop/src/renderer/src --include="*.ts" --include="*.tsx" \
  | grep -v ".test." \
  | grep -v "tCommon\|t(" \
  | head -40
```

Each line ending with `'…'` or `"…"` literal fallback is a target.

- [ ] **Step 2: For each file, decide namespace**

Use the namespace heuristic from Phase F:

| File path | Namespace |
|---|---|
| `components/inbox/**` | `inbox` |
| `components/note/**`, `pages/note*`, `pages/folder-view*`, `components/folder-view/**` | `notes` |
| `components/tasks/**`, `hooks/use-*task*` | `tasks` |
| `components/calendar/**` | `calendar` |
| `components/journal/**` | `journal` |
| `pages/settings/**`, `components/settings/**` | `settings` |
| `components/graph/**` | `graph` |
| Anything else generic | `common` (`toast.actionFailed`) |

- [ ] **Step 3: Migrate each file**

For each match:

1. Add `useT` import if missing.
2. Inside the component/hook, add `const { t } = useT('namespace')` (or reuse if already present).
3. Replace `extractErrorMessage(err, 'literal')` with `extractErrorMessage(err, t('namespace-specific.toast.key'))`. Add the key to the corresponding namespace JSON if it doesn't exist.

If the literal is genuinely generic (e.g., "Action failed", "Operation failed"), use `tCommon('toast.actionFailed')` from `common.json`.

- [ ] **Step 4: Run i18n:check to confirm no orphan keys introduced**

```bash
pnpm i18n:check
```

Expected: passes. If a new key is reported as orphan, the migration didn't actually use it — fix.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck:desktop
```

Expected: passes.

- [ ] **Step 6: Commit (one commit per file or one bundled commit; bundled is acceptable since each is mechanical)**

```bash
git add -p   # review each chunk
git commit -m "feat(i18n): sweep remaining extractErrorMessage hardcoded fallbacks"
```

---

## Task 18: Re-Run TODO Codemod and Confirm Zero New TODOs

**Files:** none modified (verification only)

- [ ] **Step 1: Run the codemod check**

```bash
pnpm i18n:codemod:todo:check
```

Expected: `0 file(s) need updates`.

If any file is reported, that means a JSX text literal landed during this phase that needs wrapping. Open the file, replace with `t()`, and re-run.

- [ ] **Step 2: Run i18n:check with strict mode**

```bash
pnpm i18n:check
```

Expected:
- `ok: i18n check passed`
- `failures.missingEnglishKeys` empty
- The number of "keys used" should be roughly +30–40 vs. pre-Phase-G baseline (the new `common.toast.*`, `common.recurrence.*`, `notes.page.toast.*`, etc.)
- The "orphan keys" count should not increase by more than ~5 (some intermediate keys may show as orphans if a planned migration was deferred)

---

## Task 19: Extend E2E Spec with Toast-Localization Scenario

**Files:**
- Modify: `apps/desktop/tests/e2e/i18n.spec.ts`

- [ ] **Step 1: Read the current spec**

```bash
cat apps/desktop/tests/e2e/i18n.spec.ts
```

Locate the existing test block for "migrated common-namespace strings flip in renderer UI" (added in Phase B).

- [ ] **Step 2: Add a new test that triggers a toast in tr/en**

Append inside the existing `test.describe('i18n', () => { ... })`:

```ts
test('toasts use the active locale (Phase G burn-down)', async () => {
  const { app, page } = await launchApp()

  // Step 1: Verify English baseline.
  // Trigger an undo with empty stack: opens the toast "Nothing to undo".
  await page.keyboard.press('Meta+z') // macOS — adjust per platform if needed
  await expect(page.getByText('Nothing to undo')).toBeVisible({ timeout: 3000 })

  // Step 2: Switch to Türkçe.
  await openSettings(page)
  await page.locator('#language-select').click()
  await page.locator('[role="option"][data-value="tr"]').click()
  await page.keyboard.press('Escape')

  // Step 3: Verify the toast falls back to English (because tr/common.json
  // has no toast.nothingToUndo key yet) — that's the documented behavior.
  // OR if Phase G also seeded the Turkish, assert the Turkish.
  // For now, just assert the toast can be triggered and renders SOMETHING
  // visible — proving the runtime path works.
  await page.keyboard.press('Meta+z')

  // The fallback chain returns the English value when tr is missing.
  // This assertion is intentionally locale-flexible: as soon as tr
  // gets the key translated, this changes to the Turkish text.
  const toastText = page.locator('[data-sonner-toast]').first()
  await expect(toastText).toBeVisible({ timeout: 3000 })

  await app.close()
})
```

- [ ] **Step 3: Build + run the e2e**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: all 5 tests pass (4 from previous phases + 1 new). If the new test fails because Cmd+Z does not fire on the boot screen, navigate to a vault first via `openVaultIfPresent(page)` helper or skip the keyboard event in favor of triggering the toast another way (e.g., open inbox, click an action that errors).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): assert toasts render in active locale post Phase G"
```

---

## Task 20: Final Verification

**Files:** none modified

- [ ] **Step 1: Lint**

```bash
pnpm lint
```

Expected: passes. The existing `i18n/no-jsx-text-literals` rule should still report zero violations.

- [ ] **Step 2: Typecheck the full workspace**

```bash
pnpm typecheck
```

Expected: passes (modulo the known pre-existing test-file errors per memry's MEMORY.md).

- [ ] **Step 3: IPC contract check**

```bash
pnpm ipc:check
```

Expected: passes. Phase G adds zero IPC surface.

- [ ] **Step 4: i18n gates**

```bash
pnpm i18n:check
pnpm i18n:codemod:todo:check
```

Expected:
- `i18n:check`: passes, no missing English keys, orphan-key count stable.
- `codemod:todo:check`: `0 file(s) need updates`.

- [ ] **Step 5: Unit + integration tests**

```bash
pnpm test
```

Expected: all green. New tests:
- `apps/desktop/src/renderer/src/hooks/use-undo.test.tsx`
- `apps/desktop/src/renderer/src/lib/repeat-utils.test.ts`
- Plus updates to existing hook tests if the snapshots changed.

- [ ] **Step 6: E2E**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: passes including the new Phase G toast scenario.

- [ ] **Step 7: Manual smoke test — flip every migrated surface in Türkçe**

```bash
pnpm dev
```

Switch to Türkçe via Settings, then walk through:

- [ ] Press Cmd+Z with nothing to undo → toast falls back to English (or Turkish if `tr/common.json` already has `toast.nothingToUndo`).
- [ ] Bulk-select tasks, complete them all → "Failed to complete tasks" / "All selected tasks are already complete" surfaces correctly on the active locale's fallback.
- [ ] Open a note, modify, delete the note from another window → trigger "Cannot save" toast.
- [ ] Open a recurring task → recurrence label reads "Every day" / "Every 3 days" / "Every weekday" via the new ICU keys.
- [ ] Right-click a sidebar tag → expand/collapse aria-label flips on locale change (inspect via DevTools → Accessibility tab).
- [ ] Tab context-menu → Pin Tab / Unpin Tab labels flip.
- [ ] Folder-view delete dialog → title uses `Delete Note` / `Delete N Notes` ICU plural; action button shows `Deleting…` while in-flight.
- [ ] Set a reminder on a note → success toast renders.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin feature/i18n-phase-g
gh pr create --title "feat(i18n): Phase G — renderer hardcoded string burn-down" --body "$(cat <<'EOF'
## Summary

Migrates ~120 user-facing English strings in the renderer that the Phase E ESLint rule (which only catches JSX text literals) cannot detect:

- 74 hardcoded `toast.*` calls in 17 files (note save errors, undo feedback, bulk task actions, reminder confirmations, template/version-history, sync export placeholder).
- ~25 hardcoded `extractErrorMessage(err, 'literal')` fallbacks across the renderer.
- 54 conditional ternaries inside JSX expressions (Pin/Unpin Tab, Saving…/Save, Expand/Collapse aria-labels, Delete Note / Delete N Notes title, isLocalOnly/willSync labels).
- 7 recurrence labels in `lib/repeat-utils.ts` — refactored to accept a `t` function parameter so the utility stays React-free.

New keys in:
- `common.json`: `toast.{nothingToUndo, undone, undoFailed, actionFailed, copied, copyFailed}`, `recurrence.*` (15 ICU plural-aware keys), `action.{expand, collapse, showMore, showLess}`, `tabs.{pin, unpin}`.
- `notes.json`: `page.toast.*`, `templateEditor.{title.*, toast.*}`, `versionHistory.toast.*`, `exportDialog.toast.*`, `reminders.toast.*`.
- `tasks.json`: `toasts.{deleted, completed, deletedSeries, deletedNext, archived, undoNotAvailableForDelete, alreadyAllComplete, noCompletedSelected, completeFailed, reopenFailed, deleteFailed, moveFailed}`.
- `settings.json`: `toast.exportNotImplemented`.

E2E (`i18n.spec.ts`) extended with one scenario asserting that a toast renders correctly post-locale-switch.

**Out of scope:** main-process strings (Phase H), ESLint rule expansion (Phase I), translation content for tr/ar.

## Test plan

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm ipc:check` passes
- [ ] `pnpm i18n:check` passes (no new missing English keys)
- [ ] `pnpm i18n:codemod:todo:check` reports 0 files
- [ ] `pnpm test` passes (new use-undo + repeat-utils tests)
- [ ] `pnpm test:e2e` passes including extended `i18n.spec.ts`
- [ ] Manual: walk through migration checklist in Task 20 step 7
EOF
)"
```

---

## Phase H + I Handoff

After Phase G merges, two follow-up phases close the i18n loop:

- `docs/superpowers/plans/2026-04-29-i18n-phase-h-main-process-completion.md` — vault picker, export dialogs, reminder notifications, IPC error responses (~13 strings in the main process).
- `docs/superpowers/plans/2026-04-29-i18n-phase-i-eslint-hardening.md` — extend the ESLint rule to catch string-attribute literals, toast-call literals, `extractErrorMessage` fallbacks, and conditional-expression literals so future regressions cannot land.
