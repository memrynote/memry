# Apply Template to an Individual Note — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user apply any template to an existing individual note from the notes-tree right-click menu or the note-page 3-dots menu, with a confirmation when the note already has body content.

**Architecture:** A new additive IPC method `notes:apply-template` runs a main-process command that reuses `applyTemplate` (pure), `updateNoteCommand` (file + index + sync), and a CRDT body-replace helper extracted from the vault watcher so an open editor updates live. The renderer reuses `TemplateSelector` in an "apply" mode, adds a three-choice confirmation dialog, and orchestrates fetch-body → confirm → IPC in one self-contained dialog component mounted at both entry points.

**Tech Stack:** Electron 39, React 19, TypeScript, Zod (contracts), Yjs CRDT, Vitest + React Testing Library, i18next.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-08-note-template-apply-design.md`.
- Backward compatibility MANDATORY: no DB schema, sync-protocol, vault file-format, or settings changes. The only contract change is the additive `notes:apply-template` method.
- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Logging: `createLogger('Scope')`; user-facing errors: `extractErrorMessage(err, fallback)`.
- All renderer↔main calls go through `packages/contracts`. After editing contracts run `pnpm ipc:generate` then `pnpm ipc:check`.
- Tailwind: logical props only (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`) in new code.
- i18n gate is English-only: add new keys to `packages/i18n/src/locales/en/notes.json`.
- Metadata merge is non-destructive: existing tags kept (union), existing property values win on key conflict.
- Do not add `Co-Authored-By` to commit messages.

---

### Task 1: IPC contract — `notes:apply-template`

**Files:**

- Modify: `packages/contracts/src/notes-channels.ts` (invoke block, after `SET_LOCAL_ONLY`/`GET_LOCAL_ONLY_COUNT`)
- Modify: `packages/contracts/src/notes-api.ts` (schema, handler signature, client API)
- Test: `packages/contracts/src/notes-api.test.ts`

**Interfaces:**

- Produces: channel `NotesChannels.invoke.APPLY_TEMPLATE = 'notes:apply-template'`; `ApplyTemplateSchema` = `z.object({ noteId: z.string(), templateId: z.string(), mode: z.enum(['full','body']) })`; client method `applyTemplate(input): Promise<NoteUpdateResponse>`.

- [ ] **Step 1: Add the channel constant**

In `notes-channels.ts`, inside `invoke`, after the `GET_LOCAL_ONLY_COUNT` line:

```ts
    /** Get count of local-only notes */
    GET_LOCAL_ONLY_COUNT: 'notes:get-local-only-count',
    /** Apply a template to an existing note (replaces body; optionally merges metadata) */
    APPLY_TEMPLATE: 'notes:apply-template'
```

- [ ] **Step 2: Add the schema + signatures in `notes-api.ts`**

After `SetLocalOnlySchema` (around line 127):

```ts
export const ApplyTemplateSchema = z.object({
  noteId: z.string(),
  templateId: z.string(),
  mode: z.enum(['full', 'body'])
})
```

In `interface NotesHandlers`, after the `REVEAL_IN_FINDER` entry:

```ts
  [NotesChannels.invoke.APPLY_TEMPLATE]: (
    input: z.infer<typeof ApplyTemplateSchema>
  ) => Promise<NoteUpdateResponse>
```

In `interface NotesClientAPI`, after `revealInFinder(...)`:

```ts
  applyTemplate(input: z.infer<typeof ApplyTemplateSchema>): Promise<NoteUpdateResponse>
```

- [ ] **Step 3: Write the failing contract test**

In `notes-api.test.ts`, add:

```ts
import { ApplyTemplateSchema } from './notes-api'

describe('ApplyTemplateSchema', () => {
  it('accepts a full-mode apply', () => {
    const r = ApplyTemplateSchema.safeParse({ noteId: 'n1', templateId: 't1', mode: 'full' })
    expect(r.success).toBe(true)
  })

  it('accepts a body-mode apply', () => {
    const r = ApplyTemplateSchema.safeParse({ noteId: 'n1', templateId: 't1', mode: 'body' })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const r = ApplyTemplateSchema.safeParse({ noteId: 'n1', templateId: 't1', mode: 'merge' })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @memry/contracts test -- notes-api`
Expected: PASS (all three assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/notes-channels.ts packages/contracts/src/notes-api.ts packages/contracts/src/notes-api.test.ts
git commit -m "feat(contracts): add notes:apply-template channel + schema"
```

---

### Task 2: Extract CRDT body-replace helper

**Files:**

- Create: `apps/desktop/src/main/sync/crdt-feed.ts`
- Modify: `apps/desktop/src/main/vault/watcher.ts:135-154` (replace private `feedExternalEditToCrdt` body to delegate)
- Test: `apps/desktop/src/main/sync/crdt-feed.test.ts`

**Interfaces:**

- Consumes: `getCrdtProvider`, `ORIGIN_LOCAL` from `../sync/crdt-provider`; `markdownToBlocks`, `blocksToYFragment` from `../sync/blocknote-converter`.
- Produces: `async function replaceNoteBodyInCrdt(noteId: string, markdown: string): Promise<boolean>` — returns `true` when a live doc was found and its body replaced, `false` when no doc is open or the markdown could not be parsed.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/sync/crdt-feed.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getDoc = vi.fn()
const markdownToBlocks = vi.fn()
const blocksToYFragment = vi.fn()

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc }),
  ORIGIN_LOCAL: 'local'
}))
vi.mock('../sync/blocknote-converter', () => ({
  markdownToBlocks: (...a: unknown[]) => markdownToBlocks(...a),
  blocksToYFragment: (...a: unknown[]) => blocksToYFragment(...a)
}))

import { replaceNoteBodyInCrdt } from './crdt-feed'

function makeDoc() {
  const fragment = { delete: vi.fn(), length: 3 }
  return {
    getXmlFragment: vi.fn(() => fragment),
    transact: vi.fn((fn: () => void) => fn()),
    _fragment: fragment
  }
}

beforeEach(() => {
  getDoc.mockReset()
  markdownToBlocks.mockReset()
  blocksToYFragment.mockReset()
})

describe('replaceNoteBodyInCrdt', () => {
  it('returns false when no doc is open', async () => {
    getDoc.mockReturnValue(null)
    expect(await replaceNoteBodyInCrdt('n1', '# hi')).toBe(false)
    expect(markdownToBlocks).not.toHaveBeenCalled()
  })

  it('returns false when markdown does not parse', async () => {
    getDoc.mockReturnValue(makeDoc())
    markdownToBlocks.mockResolvedValue(null)
    expect(await replaceNoteBodyInCrdt('n1', '')).toBe(false)
  })

  it('clears the fragment then rebuilds it once when a doc is open', async () => {
    const doc = makeDoc()
    getDoc.mockReturnValue(doc)
    markdownToBlocks.mockResolvedValue([{ type: 'paragraph' }])
    const ok = await replaceNoteBodyInCrdt('n1', '# hi')
    expect(ok).toBe(true)
    expect(doc._fragment.delete).toHaveBeenCalledWith(0, 3)
    expect(blocksToYFragment).toHaveBeenCalledTimes(1)
    expect(doc.transact).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- crdt-feed`
Expected: FAIL — cannot resolve `./crdt-feed`.

- [ ] **Step 3: Create the helper**

Create `apps/desktop/src/main/sync/crdt-feed.ts`:

```ts
/**
 * Shared CRDT body-replace: swap an open note's editor body for new markdown.
 * Used by the vault watcher (external file edits) and template-apply.
 *
 * @module sync/crdt-feed
 */

import { getCrdtProvider, ORIGIN_LOCAL } from './crdt-provider'
import { markdownToBlocks, blocksToYFragment } from './blocknote-converter'

/**
 * Full XML-fragment replace of a note's body inside its live Y.Doc.
 * No-op (returns false) when the doc is not open or the markdown is unparseable.
 * Lossy re: Yjs history, but round-tripping through markdown discards it anyway.
 */
export async function replaceNoteBodyInCrdt(noteId: string, markdown: string): Promise<boolean> {
  const provider = getCrdtProvider()
  const doc = provider.getDoc(noteId)
  if (!doc) return false

  const blocks = await markdownToBlocks(markdown)
  if (!blocks) return false

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(blocks, fragment)
  }, ORIGIN_LOCAL)

  return true
}
```

- [ ] **Step 4: Rewire the watcher to delegate**

In `apps/desktop/src/main/vault/watcher.ts`, replace the private `feedExternalEditToCrdt` (lines ~135-154) with a version that keeps the concurrent-edit emit and delegates the fragment work. Add the import near the other `../sync/*` imports:

```ts
import { replaceNoteBodyInCrdt } from '../sync/crdt-feed'
```

Replace the function body:

```ts
// Full fragment replace on external edits: lossy but acceptable since
// out-of-app edits are infrequent and round-trip through MD destroys Yjs history anyway
async function feedExternalEditToCrdt(noteId: string, markdownContent: string): Promise<void> {
  const provider = getCrdtProvider()
  if (!provider.getDoc(noteId)) return

  if (wasRecentNetworkUpdate(noteId)) {
    emitEvent('sync:concurrent-edit', { noteId })
  }

  await replaceNoteBodyInCrdt(noteId, markdownContent)
}
```

Leave the existing `markdownToBlocks`/`blocksToYFragment` imports in `watcher.ts` only if still referenced elsewhere in the file; if this was their sole use, remove them from the watcher import to avoid an unused-import lint error (verify with the grep below).

- [ ] **Step 5: Verify no orphan imports in watcher**

Run: `grep -n "markdownToBlocks\|blocksToYFragment\|getXmlFragment" apps/desktop/src/main/vault/watcher.ts`
Expected: no remaining references except the (now-removed) old body. If `markdownToBlocks`/`blocksToYFragment` no longer appear, delete them from the watcher's import statement.

- [ ] **Step 6: Run tests (new helper + existing watcher)**

Run: `pnpm --filter @memry/desktop test:main -- crdt-feed watcher`
Expected: PASS — new helper tests green; existing watcher tests still green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/sync/crdt-feed.ts apps/desktop/src/main/sync/crdt-feed.test.ts apps/desktop/src/main/vault/watcher.ts
git commit -m "refactor(sync): extract replaceNoteBodyInCrdt shared helper"
```

---

### Task 3: Main command — `applyTemplateToNote`

**Files:**

- Create: `apps/desktop/src/main/notes/apply-template.ts`
- Test: `apps/desktop/src/main/notes/apply-template.test.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts` (import + register handler)

**Interfaces:**

- Consumes: `applyTemplate`, `getTemplate` from `../vault/templates`; `getNoteById`, `updateNote`, type `Note`, `NoteUpdateInput` from `../vault/notes`; `replaceNoteBodyInCrdt` from `../sync/crdt-feed`; `updateNoteCommand` from `./domain`; `NoteError`, `NoteErrorCode` from `../lib/errors`.
- Produces: pure `buildTemplateApplyUpdate(note: Note, template: Template, mode: 'full' | 'body'): NoteUpdateInput`; `async function applyTemplateToNote(input: { noteId: string; templateId: string; mode: 'full' | 'body' }): Promise<Note>`.

- [ ] **Step 1: Write the failing test for the pure builder**

Create `apps/desktop/src/main/notes/apply-template.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTemplateApplyUpdate } from './apply-template'
import type { Template } from '@memry/contracts/templates-api'

const template: Template = {
  id: 't1',
  name: 'Meeting',
  description: undefined,
  icon: null,
  isBuiltIn: false,
  tags: ['meeting', 'work'],
  properties: [
    { name: 'status', type: 'select', value: 'scheduled', options: ['scheduled', 'done'] },
    { name: 'attendees', type: 'text', value: '' }
  ],
  content: '# {{title}}\n\n## Notes\n',
  createdAt: '2026-07-08T00:00:00.000Z',
  modifiedAt: '2026-07-08T00:00:00.000Z'
}

const note = {
  id: 'n1',
  title: 'Standup',
  tags: ['work', 'daily'],
  properties: { status: 'done', priority: 5 }
  // other Note fields unused by buildTemplateApplyUpdate
} as unknown as import('../vault/notes').Note

describe('buildTemplateApplyUpdate', () => {
  it('resolves {{title}} to the note title in the body', () => {
    const u = buildTemplateApplyUpdate(note, template, 'full')
    expect(u.content).toContain('# Standup')
    expect(u.content).not.toContain('{{title}}')
  })

  it('full mode: unions tags and merges properties with existing winning', () => {
    const u = buildTemplateApplyUpdate(note, template, 'full')
    expect(new Set(u.tags)).toEqual(new Set(['work', 'daily', 'meeting']))
    // existing status 'done' wins over template 'scheduled'; template adds 'attendees'; existing priority kept
    expect(u.properties).toEqual({ status: 'done', priority: 5, attendees: '' })
  })

  it('body mode: leaves tags and properties undefined (untouched by updateNote)', () => {
    const u = buildTemplateApplyUpdate(note, template, 'body')
    expect(u.tags).toBeUndefined()
    expect(u.properties).toBeUndefined()
    expect(u.content).toContain('## Notes')
  })

  it('always targets the note id', () => {
    expect(buildTemplateApplyUpdate(note, template, 'full').id).toBe('n1')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- apply-template`
Expected: FAIL — cannot resolve `./apply-template`.

- [ ] **Step 3: Implement the command + builder**

Create `apps/desktop/src/main/notes/apply-template.ts`:

```ts
/**
 * Apply a template to an existing note: replace the body, optionally merge
 * the template's tags/properties (non-destructive), and update any open editor.
 *
 * @module notes/apply-template
 */

import { applyTemplate, getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { updateNoteCommand } from './domain'
import { replaceNoteBodyInCrdt } from '../sync/crdt-feed'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { VaultError, VaultErrorCode } from '../lib/errors'
import type { Template } from '@memry/contracts/templates-api'

/**
 * Build the NoteUpdateInput for applying a template to a note.
 * - `full`: union tags, merge properties (existing values win on conflict).
 * - `body`: content only; tags/properties left undefined so updateNote keeps them.
 */
export function buildTemplateApplyUpdate(
  note: Note,
  template: Template,
  mode: 'full' | 'body'
): NoteUpdateInput {
  const applied = applyTemplate(template, note.title)
  const update: NoteUpdateInput = { id: note.id, content: applied.content }

  if (mode === 'full') {
    update.tags = [...new Set([...note.tags, ...applied.tags])]
    update.properties = { ...applied.properties, ...note.properties }
  }

  return update
}

export async function applyTemplateToNote(input: {
  noteId: string
  templateId: string
  mode: 'full' | 'body'
}): Promise<Note> {
  const note = await getNoteById(input.noteId)
  if (!note) {
    throw new NoteError(`Note not found: ${input.noteId}`, NoteErrorCode.NOT_FOUND, input.noteId)
  }

  const template = await getTemplate(input.templateId)
  if (!template) {
    throw new VaultError(`Template not found: ${input.templateId}`, VaultErrorCode.NOT_FOUND)
  }

  const update = buildTemplateApplyUpdate(note, template, input.mode)
  const updated = await updateNoteCommand(update)

  // Update any open editor's Y.Doc so the replacement shows live.
  await replaceNoteBodyInCrdt(input.noteId, update.content ?? '')

  return updated
}
```

Note on the two `errors` imports: if `NoteError`/`NoteErrorCode` and `VaultError`/`VaultErrorCode` live in the same module, combine into one import line. Verify the exact export locations before writing (`grep -n "VaultErrorCode\|NoteErrorCode" apps/desktop/src/main/lib/errors.ts`).

- [ ] **Step 4: Run the builder test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- apply-template`
Expected: PASS.

- [ ] **Step 5: Register the IPC handler**

In `apps/desktop/src/main/ipc/notes-handlers.ts`:

Add to the contracts import block (with the other schemas):

```ts
;(SetLocalOnlySchema, ApplyTemplateSchema)
```

Add the command import (near `updateNoteCommand`):

```ts
import { applyTemplateToNote } from '../notes/apply-template'
```

Register the handler right after the `notes:update` `registerCommand(...)` block (after line ~288):

```ts
// notes:apply-template - Apply a template to an existing note
registerCommand(
  NotesChannels.invoke.APPLY_TEMPLATE,
  ApplyTemplateSchema,
  async (input) => {
    const note = await applyTemplateToNote(input)
    return { success: true as const, note }
  },
  'Failed to apply template'
)
```

- [ ] **Step 6: Regenerate + validate IPC bindings**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: invoke map regenerated; `ipc:check` passes. `window.api.notes.applyTemplate` now exists in generated types.

- [ ] **Step 7: Typecheck the node side**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/notes/apply-template.ts apps/desktop/src/main/notes/apply-template.test.ts apps/desktop/src/main/ipc/notes-handlers.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(notes): apply-template main command + IPC handler"
```

---

### Task 4: TemplateSelector — apply mode

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/template-selector.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json` (`templateSelector.applyToNote`, `templateSelector.applyTitle`, `templateSelector.applyDescription`)
- Test: extend `apps/desktop/src/renderer/src/pages/templates.test.tsx` OR add `apps/desktop/src/renderer/src/components/note/template-selector.test.tsx`

**Interfaces:**

- Produces: `TemplateSelectorProps` gains optional `applyMode?: boolean`. When true: folder/journal default checkboxes are suppressed regardless of other props, the primary button label is `t('templateSelector.applyToNote')`, and the header uses apply-specific title/description.

- [ ] **Step 1: Add the i18n keys**

In `packages/i18n/src/locales/en/notes.json`, inside `templateSelector`, add:

```json
    "applyToNote": "Apply Template",
    "applyTitle": "Apply a Template",
    "applyDescription": "Replace this note's content with a template"
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/components/note/template-selector.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TemplateSelector } from './template-selector'

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [{ id: 'blank', name: 'Blank Note', description: '', icon: '📄', isBuiltIn: true }],
    isLoading: false
  })
}))

describe('TemplateSelector apply mode', () => {
  it('shows the Apply label and hides the folder-default checkbox', () => {
    render(
      <TemplateSelector
        isOpen
        applyMode
        folderPath="projects"
        onSetFolderDefault={vi.fn()}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('Apply Template')).toBeInTheDocument()
    expect(screen.queryByText('Set as folder default')).not.toBeInTheDocument()
  })
})
```

(Adjust the folder-default label string to match the current `en/notes.json` value for `templateSelector.setFolderDefault`.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- template-selector`
Expected: FAIL — `applyMode` prop unknown / Apply label absent.

- [ ] **Step 4: Implement apply mode**

In `template-selector.tsx`:

Add to `TemplateSelectorProps`:

```ts
  /** Apply-to-existing-note mode: hides default checkboxes, relabels primary button */
  applyMode?: boolean
```

Destructure `applyMode = false` in the component signature.

Gate the footer checkboxes so apply mode never renders them — wrap the existing folder/journal checkbox block with `{!applyMode && ( ... )}`, keeping the current inner conditions.

Header title/description:

```tsx
{
  applyMode ? t('templateSelector.applyTitle') : t('templateSelector.title')
}
```

```tsx
{
  applyMode ? t('templateSelector.applyDescription') : t('templateSelector.description')
}
```

Primary button label:

```tsx
{
  applyMode
    ? t('templateSelector.applyToNote')
    : isJournalContext
      ? t('templateSelector.useTemplate')
      : t('templateSelector.createNote')
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- template-selector`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/template-selector.tsx apps/desktop/src/renderer/src/components/note/template-selector.test.tsx packages/i18n/src/locales/en/notes.json
git commit -m "feat(notes): TemplateSelector apply-to-note mode"
```

---

### Task 5: Confirmation dialog component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/apply-template-confirm-dialog.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json` (`applyTemplateConfirm.*`)
- Test: `apps/desktop/src/renderer/src/components/note/apply-template-confirm-dialog.test.tsx`

**Interfaces:**

- Produces: `ApplyTemplateConfirmDialog` with props `{ isOpen: boolean; templateName: string; onCancel: () => void; onConfirm: (mode: 'full' | 'body') => void }`. Renders a warning that content will be replaced and two action buttons: "Replace content & add template details" → `onConfirm('full')`; "Replace content only" → `onConfirm('body')`; plus Cancel → `onCancel()`.

- [ ] **Step 1: Add i18n keys**

In `packages/i18n/src/locales/en/notes.json`, add a top-level object:

```json
  "applyTemplateConfirm": {
    "title": "Replace note content?",
    "description": "Applying \"{name}\" will replace this note's current content. This can't be undone.",
    "full": "Replace content & add template details",
    "body": "Replace content only",
    "cancel": "Cancel"
  }
```

- [ ] **Step 2: Write the failing test**

Create `apply-template-confirm-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApplyTemplateConfirmDialog } from './apply-template-confirm-dialog'

describe('ApplyTemplateConfirmDialog', () => {
  it('calls onConfirm with full then body, and onCancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <ApplyTemplateConfirmDialog
        isOpen
        templateName="Meeting"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    await user.click(screen.getByText('Replace content & add template details'))
    expect(onConfirm).toHaveBeenCalledWith('full')

    rerender(
      <ApplyTemplateConfirmDialog
        isOpen
        templateName="Meeting"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
    await user.click(screen.getByText('Replace content only'))
    expect(onConfirm).toHaveBeenCalledWith('body')

    await user.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- apply-template-confirm-dialog`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the dialog**

Create `apply-template-confirm-dialog.tsx` (mirror the `Dialog` primitives already used by `template-selector.tsx`):

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

interface ApplyTemplateConfirmDialogProps {
  isOpen: boolean
  templateName: string
  onCancel: () => void
  onConfirm: (mode: 'full' | 'body') => void
}

export function ApplyTemplateConfirmDialog({
  isOpen,
  templateName,
  onCancel,
  onConfirm
}: ApplyTemplateConfirmDialogProps) {
  const { t } = useT('notes')

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('applyTemplateConfirm.title')}</DialogTitle>
          <DialogDescription>
            {t('applyTemplateConfirm.description', { name: templateName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button onClick={() => onConfirm('full')}>{t('applyTemplateConfirm.full')}</Button>
          <Button variant="outline" onClick={() => onConfirm('body')}>
            {t('applyTemplateConfirm.body')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('applyTemplateConfirm.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ApplyTemplateConfirmDialog
```

Verify `DialogFooter` is exported from `@/components/ui/dialog`; if not, use a plain `<div className="flex flex-col gap-2">` instead.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- apply-template-confirm-dialog`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/apply-template-confirm-dialog.tsx apps/desktop/src/renderer/src/components/note/apply-template-confirm-dialog.test.tsx packages/i18n/src/locales/en/notes.json
git commit -m "feat(notes): apply-template confirmation dialog"
```

---

### Task 6: Orchestrator — `ApplyTemplateToNoteDialog`

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/apply-template-to-note-dialog.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/apply-template-to-note-dialog.test.tsx`

**Interfaces:**

- Consumes: `TemplateSelector` (applyMode), `ApplyTemplateConfirmDialog`, `window.api.notes.get`, `window.api.notes.applyTemplate`, `useTemplates` (to resolve a template name for the confirm copy), `extractErrorMessage`, toast.
- Produces: `ApplyTemplateToNoteDialog` with props `{ noteId: string | null; isOpen: boolean; onClose: () => void }`. Flow: selector → on select, `notes.get(noteId)`; if `note.content.trim()` is non-empty → show confirm; else → apply `mode:'full'` directly; confirm choice → `notes.applyTemplate({ noteId, templateId, mode })`; success/failure toast; `onClose`.

- [ ] **Step 1: Write the failing test**

Create `apply-template-to-note-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApplyTemplateToNoteDialog } from './apply-template-to-note-dialog'

const get = vi.fn()
const applyTemplate = vi.fn()

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [{ id: 'blank', name: 'Blank Note', description: '', icon: '📄', isBuiltIn: true }],
    isLoading: false
  })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  get.mockReset()
  applyTemplate.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { notes: { get, applyTemplate } }
  } as never
})

describe('ApplyTemplateToNoteDialog', () => {
  it('empty note: applies full mode without confirmation', async () => {
    get.mockResolvedValue({ id: 'n1', content: '   ' })
    applyTemplate.mockResolvedValue({ success: true, note: { id: 'n1' } })
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<ApplyTemplateToNoteDialog noteId="n1" isOpen onClose={onClose} />)
    // 'blank' is the default selection; click the Apply primary button
    await user.click(screen.getByText('Apply Template'))

    expect(applyTemplate).toHaveBeenCalledWith({ noteId: 'n1', templateId: 'blank', mode: 'full' })
  })

  it('non-empty note: shows confirm, then applies chosen mode', async () => {
    get.mockResolvedValue({ id: 'n1', content: '# Existing content' })
    applyTemplate.mockResolvedValue({ success: true, note: { id: 'n1' } })
    const user = userEvent.setup()

    render(<ApplyTemplateToNoteDialog noteId="n1" isOpen onClose={vi.fn()} />)
    await user.click(screen.getByText('Apply Template'))
    // confirm dialog appears
    await user.click(await screen.findByText('Replace content only'))

    expect(applyTemplate).toHaveBeenCalledWith({ noteId: 'n1', templateId: 'blank', mode: 'body' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- apply-template-to-note-dialog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `apply-template-to-note-dialog.tsx`:

```tsx
import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { TemplateSelector } from './template-selector'
import { ApplyTemplateConfirmDialog } from './apply-template-confirm-dialog'
import { useTemplates } from '@/hooks/use-templates'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

interface ApplyTemplateToNoteDialogProps {
  noteId: string | null
  isOpen: boolean
  onClose: () => void
}

export function ApplyTemplateToNoteDialog({
  noteId,
  isOpen,
  onClose
}: ApplyTemplateToNoteDialogProps) {
  const { t } = useT('notes')
  const { templates } = useTemplates()
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null)

  const apply = useCallback(
    async (templateId: string, mode: 'full' | 'body') => {
      if (!noteId) return
      try {
        const res = await window.api.notes.applyTemplate({ noteId, templateId, mode })
        if (!res.success) throw new Error(res.error ?? 'apply failed')
        toast.success(t('applyTemplateConfirm.title'))
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to apply template'))
      } finally {
        setPendingTemplateId(null)
        onClose()
      }
    },
    [noteId, onClose, t]
  )

  const handleSelect = useCallback(
    async (templateId: string | null) => {
      if (!noteId || !templateId) {
        onClose()
        return
      }
      const note = await window.api.notes.get(noteId)
      const hasContent = !!note?.content?.trim()
      if (hasContent) {
        setPendingTemplateId(templateId)
      } else {
        await apply(templateId, 'full')
      }
    },
    [noteId, apply, onClose]
  )

  const pendingTemplateName = templates.find((tpl) => tpl.id === pendingTemplateId)?.name ?? ''

  return (
    <>
      <TemplateSelector
        isOpen={isOpen && pendingTemplateId === null}
        applyMode
        onClose={onClose}
        onSelect={(id) => void handleSelect(id)}
      />
      <ApplyTemplateConfirmDialog
        isOpen={pendingTemplateId !== null}
        templateName={pendingTemplateName}
        onCancel={() => {
          setPendingTemplateId(null)
          onClose()
        }}
        onConfirm={(mode) => {
          if (pendingTemplateId) void apply(pendingTemplateId, mode)
        }}
      />
    </>
  )
}

export default ApplyTemplateToNoteDialog
```

Confirm the toast import matches the codebase (`sonner` vs a local `useToast`); align both the implementation and the test mock to whatever the repo uses (grep `from 'sonner'` under `renderer/src`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- apply-template-to-note-dialog`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/apply-template-to-note-dialog.tsx apps/desktop/src/renderer/src/components/note/apply-template-to-note-dialog.test.tsx
git commit -m "feat(notes): apply-template-to-note orchestrator dialog"
```

---

### Task 7: Entry point — note page 3-dots menu

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/note.tsx` (Picker menu ~lines 963-1030, plus state + dialog mount)
- Modify: `packages/i18n/src/locales/en/notes.json` (`editor.toolbar.applyTemplate`)

**Interfaces:**

- Consumes: `ApplyTemplateToNoteDialog` (Task 6); existing `noteId`, `note`, `setMoreMenuOpen` in `note.tsx`.

- [ ] **Step 1: Add the menu i18n key**

In `en/notes.json`, inside `editor.toolbar`, add:

```json
    "applyTemplate": "Apply Template"
```

- [ ] **Step 2: Add local state + import in `note.tsx`**

Near the other `useState` hooks (around line 168):

```tsx
const [isApplyTemplateOpen, setIsApplyTemplateOpen] = useState(false)
```

Add the import with the other note-component imports:

```tsx
import { ApplyTemplateToNoteDialog } from '@/components/note/apply-template-to-note-dialog'
```

Pick an icon already exported from `@/lib/icons` (e.g. `PenLine` — used by `template-selector.tsx`) and add it to the existing `@/lib/icons` import in `note.tsx`.

- [ ] **Step 3: Handle the menu action**

In the `Picker` `onValueChange` (around line 966), add a branch alongside the others:

```tsx
if (action === 'apply-template') setIsApplyTemplateOpen(true)
```

Add a `Picker.Item` in the list (after the `export` item, before the `Picker.Separator`):

```tsx
<Picker.Item
  value="apply-template"
  label={t('editor.toolbar.applyTemplate')}
  icon={<PenLine className="size-4" />}
/>
```

- [ ] **Step 4: Mount the dialog**

Near the other note-level dialogs (e.g. beside `<VersionHistory ... />` around line 1230):

```tsx
<ApplyTemplateToNoteDialog
  noteId={noteId}
  isOpen={isApplyTemplateOpen}
  onClose={() => setIsApplyTemplateOpen(false)}
/>
```

- [ ] **Step 5: Typecheck the web side**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/note.tsx packages/i18n/src/locales/en/notes.json
git commit -m "feat(notes): apply-template entry in note-page 3-dots menu"
```

---

### Task 8: Entry point — notes-tree right-click menu

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx` (note ContextMenu ~line 621; note-item + tree props)
- Modify: `apps/desktop/src/renderer/src/components/notes-tree.tsx` (thread callback + mount dialog)
- Modify: `packages/i18n/src/locales/en/notes.json` (`contextMenu.applyTemplate` — match the namespace/key style of the existing note context-menu labels; verify the current key used for "Rename")

**Interfaces:**

- Consumes: `ApplyTemplateToNoteDialog` (Task 6). New optional prop `onApplyTemplateToNote?: (note: NoteListItem) => void` threaded from `notes-tree.tsx` → `VirtualizedNotesTree` → note item.

- [ ] **Step 1: Confirm the existing note context-menu label key**

Run: `grep -n "onRenameNote\|contextMenu\|t('notes'\|useT(" apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx | head`
Note the translation key pattern used for the note "Rename" item; reuse that namespace for `applyTemplate`. Add the matching key to `en/notes.json`.

- [ ] **Step 2: Add the prop through the tree types**

In `virtualized-notes-tree.tsx`, add `onApplyTemplateToNote?: (note: NoteListItem) => void` to both the top-level tree props interface (near `onRenameNote?`, ~line 97) and the note-item props interface (near `onRenameNote?`, ~line 455). Destructure it in the note-item component alongside `onRenameNote`.

- [ ] **Step 3: Add the context-menu item**

In the note `ContextMenu` (right after the Rename item at ~line 621):

```tsx
<ContextMenuItem onClick={() => onApplyTemplateToNote?.(item.note)}>
  {t('<same-namespace-key>.applyTemplate')}
</ContextMenuItem>
```

Use the exact `t(...)` call style the surrounding items use (icon optional — match neighbors; e.g. add `<PenLine className="mr-2 h-4 w-4" />` if the neighboring items render icons).

- [ ] **Step 4: Thread + mount in `notes-tree.tsx`**

Add state near the other tree dialog state:

```tsx
const [applyTemplateNote, setApplyTemplateNote] = useState<NoteListItem | null>(null)
```

Add the import:

```tsx
import { ApplyTemplateToNoteDialog } from '@/components/note/apply-template-to-note-dialog'
```

Pass the callback into `<VirtualizedNotesTree ... >` (in the props block ~line 539):

```tsx
onApplyTemplateToNote = { setApplyTemplateNote }
```

Mount the dialog next to `<NoteTreeTemplateSelector ... />` (~line 603):

```tsx
<ApplyTemplateToNoteDialog
  noteId={applyTemplateNote?.id ?? null}
  isOpen={applyTemplateNote !== null}
  onClose={() => setApplyTemplateNote(null)}
/>
```

Ensure `NoteListItem` and `useState` are imported in `notes-tree.tsx` (they are already used; confirm).

- [ ] **Step 5: Typecheck the web side**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx apps/desktop/src/renderer/src/components/notes-tree.tsx packages/i18n/src/locales/en/notes.json
git commit -m "feat(notes): apply-template entry in notes-tree context menu"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: i18n check**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (all new `notes` keys present in English).

- [ ] **Step 2: IPC contract check**

Run: `pnpm ipc:check`
Expected: invoke map up to date.

- [ ] **Step 3: Lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors introduced. (Pre-existing type errors in `websocket.test.ts` / `folders.test.ts` are known and ignorable per CLAUDE.md.)

- [ ] **Step 4: Targeted tests**

Run: `pnpm --filter @memry/contracts test -- notes-api && pnpm --filter @memry/desktop test:main -- "crdt-feed|apply-template|watcher" && pnpm --filter @memry/desktop test:renderer -- "template-selector|apply-template"`
Expected: all green. (If desktop full-run SIGSEGV appears, it is the known parallel flake — re-run the specific file.)

- [ ] **Step 5: Docs impact gate**

This touches `apps/desktop` and IPC contracts. Run:
`pnpm docs:impact --base origin/main --strict`
If it reports `missing-docs`, run `pnpm docs:ai-update --base origin/main` (or update `apps/docs/src` manually), then re-run `pnpm docs:impact --base origin/main --strict` and `pnpm docs:build`.

- [ ] **Step 6: Manual smoke (live Electron)**

Run: `pnpm dev`

- Right-click a note in the sidebar → **Apply Template** → pick a template.
  - Empty note → content appears immediately, no dialog.
  - Note with content → confirmation dialog; choose "Replace content only" and "Replace content & add template details"; verify body replaces and (full) tags/properties merge non-destructively.
- Open a note → 3-dots → **Apply Template** → same behavior; with the editor open, confirm the body updates live (CRDT feed).

---

## Self-Review Notes

- **Spec coverage:** entry points (Tasks 7, 8), reuse selector (Task 4), confirm-on-content with two apply choices (Tasks 5, 6), empty→silent full apply (Task 6), non-destructive merge + `{{title}}` (Task 3), live editor sync via extracted CRDT helper (Tasks 2, 3), additive IPC only (Task 1), i18n/backward-compat (Task 9). All covered.
- **Type consistency:** `mode: 'full' | 'body'` and the `{ noteId, templateId, mode }` shape are identical across contract (Task 1), main command (Task 3), orchestrator, and IPC calls (Task 6). `buildTemplateApplyUpdate` / `applyTemplateToNote` / `replaceNoteBodyInCrdt` names are used consistently.
- **Known verification points flagged inline:** exact `errors.ts` export module for `VaultError`/`NoteError` (Task 3 Step 3), `DialogFooter` export (Task 5), toast library (`sonner` vs local) (Task 6), and the note context-menu translation-key namespace (Task 8 Step 1) — each has a grep to confirm before writing, avoiding a guessed import.
