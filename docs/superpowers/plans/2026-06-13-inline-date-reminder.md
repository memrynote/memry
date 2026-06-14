# Inline Date / Reminder Mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Notion-style inline date pill to notes (`/date` → picker) that always carries calendar value and can opt into a reminder which fires into the Inbox and scrolls back to the exact pill.

**Architecture:** The inline `dateMention` node in the note body (synced via CRDT) is the single source of truth. It serializes to a markdown token. A main-process derive bridge parses those tokens on every note write and upserts/deletes **local** `note_date` reminder rows, which the existing reminder engine fires into the Inbox. Navigation scrolls to the pill by a stable `anchorId`.

**Tech Stack:** Electron 39 + React 19, BlockNote (`createInlineContentSpec`), Drizzle (better-sqlite3), `@memry/app-core` RemindersService, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-13-inline-date-reminder-design.md`

**Scope:** MVP only (editor pill + picker + reminder derive + inbox fire + scroll-to). Calendar surfacing is **Phase 2** — a separate plan.

---

## File Structure

| File                                                                                    | Responsibility                                                               | New/Modify |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `packages/shared/src/date-mention.ts`                                                   | Token format + `computeRemindAt(dateISO, lead)` — the renderer↔main contract | New        |
| `packages/shared/src/date-mention.test.ts`                                              | Token round-trip + lead math                                                 | New        |
| `packages/shared/package.json`                                                          | Add `./date-mention` subpath export                                          | Modify     |
| `packages/contracts/src/reminder-types.ts`                                              | Add `note_date` target type                                                  | Modify     |
| `packages/db-schema/src/schema/reminders.ts`                                            | Add nullable `anchorId` column                                               | Modify     |
| `packages/contracts/src/inbox-api.ts`                                                   | Add `anchorId?` to `ReminderMetadata`                                        | Modify     |
| `apps/desktop/src/renderer/src/components/note/content-area/date-mention.tsx`           | `dateMention` inline content spec (pill render/parse/serialize)              | New        |
| `apps/desktop/src/renderer/src/components/note/content-area/date-mention.test.ts`       | Spec round-trip                                                              | New        |
| `apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.ts`      | `normalizeDateMentions(blocks)` load-time hydrate                            | New        |
| `apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.test.ts` | Hydrate test                                                                 | New        |
| `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`           | Register `dateMention`                                                       | Modify     |
| `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts`   | Call `normalizeDateMentions` alongside link mentions                         | Modify     |
| `apps/desktop/src/renderer/src/components/note/content-area/date-mention-popover.tsx`   | Picker popover (date/time, remind toggle, lead)                              | New        |
| `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`            | `/date` slash item in `getItems`                                             | Modify     |
| `apps/desktop/src/main/notes/note-date-reminders.ts`                                    | Derive bridge: tokens → note_date reminder rows (diff/upsert/delete)         | New        |
| `apps/desktop/src/main/notes/note-date-reminders.test.ts`                               | Derive-diff unit tests                                                       | New        |
| `apps/desktop/src/main/vault/notes-crud.ts`                                             | Call derive on create/update; clear on delete                                | Modify     |
| `apps/desktop/src/main/lib/reminders.ts`                                                | Put `anchorId` into `ReminderMetadata` when building inbox item              | Modify     |
| `apps/desktop/src/renderer/src/lib/reminder-panel.ts`                                   | Carry `anchorId` in `ReminderEntryNav`                                       | Modify     |
| `apps/desktop/src/renderer/src/pages/note.tsx`                                          | Scroll to `[data-anchor-id]` when nav has `anchorId`                         | Modify     |

**Verify commands (run from worktree root `.worktrees/inline-reminder`):**

- Shared/contracts/app-core node tests: `pnpm --filter @memry/shared test`
- Renderer tests: `pnpm --filter @memry/desktop test:renderer`
- Main tests: `pnpm --filter @memry/desktop test:main`
- Types: `pnpm --filter @memry/desktop typecheck:web` and `typecheck:node`
- Contract boundary: `pnpm ipc:check`
- Lint: `pnpm lint`

> Renderer tests must use the project config: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer <file>` (bare `vitest run <file>` fails the `@tests` alias).

---

## Task 1: Shared date-mention token + lead math

The token is the durable contract between the renderer pill and the main derive bridge. Pure functions, no deps.

**Files:**

- Create: `packages/shared/src/date-mention.ts`
- Test: `packages/shared/src/date-mention.test.ts`
- Modify: `packages/shared/package.json` (subpath export)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/date-mention.test.ts
import { describe, it, expect } from 'vitest'
import {
  DATE_MENTION_TOKEN_REGEX,
  serializeDateMentionToken,
  parseDateMentionToken,
  computeRemindAt,
  type DateMentionData
} from './date-mention'

const base: DateMentionData = {
  anchorId: 'dm_abc123',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  remind: true,
  lead: '1h'
}

describe('date-mention token', () => {
  it('round-trips through serialize/parse', () => {
    const token = serializeDateMentionToken(base)
    const parsed = parseDateMentionToken(token.replace(/^\(\(date:|\)\)$/g, ''))
    expect(parsed).toEqual(base)
  })

  it('matches the token regex', () => {
    const token = serializeDateMentionToken(base)
    const matches = [...`x ${token} y`.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(matches).toHaveLength(1)
  })

  it('parses every token in a markdown string', () => {
    const a = serializeDateMentionToken(base)
    const b = serializeDateMentionToken({ ...base, anchorId: 'dm_def', remind: false, lead: 'at' })
    const all = [...`${a} mid ${b}`.matchAll(DATE_MENTION_TOKEN_REGEX)].map((m) =>
      parseDateMentionToken(m[1])
    )
    expect(all.map((d) => d?.anchorId)).toEqual(['dm_abc123', 'dm_def'])
    expect(all[1]?.remind).toBe(false)
  })

  it('returns null on malformed payload', () => {
    expect(parseDateMentionToken('not-json')).toBeNull()
  })

  it('computeRemindAt subtracts the lead offset', () => {
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', 'at')).toBe('2026-06-20T09:00:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '5m')).toBe('2026-06-20T08:55:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '1h')).toBe('2026-06-20T08:00:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '1d')).toBe('2026-06-19T09:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/shared exec vitest run src/date-mention.test.ts`
Expected: FAIL — `Cannot find module './date-mention'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/date-mention.ts

/**
 * Durable token for inline date mentions. The renderer pill serializes its
 * props to `((date:<base64url-json>))` so the date survives the markdown
 * round-trip as a single text node, and the main process derives reminder
 * rows by parsing the same token out of the note's raw markdown. This module
 * is the single source of truth for the format — imported by both sides.
 */

export type DateMentionLead = 'at' | '5m' | '1h' | '1d'

export interface DateMentionData {
  anchorId: string
  dateISO: string
  hasTime: boolean
  remind: boolean
  lead: DateMentionLead
}

export const DATE_MENTION_TOKEN_REGEX = /\(\(date:([A-Za-z0-9\-_]+)\)\)/g

const LEAD_MS: Record<DateMentionLead, number> = {
  at: 0,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
}

function toBase64Url(s: string): string {
  // btoa/atob exist in both renderer (browser) and Electron main (Node 20+).
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded)
}

export function serializeDateMentionToken(data: DateMentionData): string {
  return `((date:${toBase64Url(JSON.stringify(data))}))`
}

export function parseDateMentionToken(encoded: string): DateMentionData | null {
  try {
    const obj = JSON.parse(fromBase64Url(encoded)) as Partial<DateMentionData>
    if (
      typeof obj.anchorId !== 'string' ||
      typeof obj.dateISO !== 'string' ||
      typeof obj.hasTime !== 'boolean' ||
      typeof obj.remind !== 'boolean' ||
      (obj.lead !== 'at' && obj.lead !== '5m' && obj.lead !== '1h' && obj.lead !== '1d')
    ) {
      return null
    }
    return obj as DateMentionData
  } catch {
    return null
  }
}

export function computeRemindAt(dateISO: string, lead: DateMentionLead): string {
  return new Date(Date.parse(dateISO) - LEAD_MS[lead]).toISOString()
}
```

- [ ] **Step 4: Add the subpath export**

In `packages/shared/package.json`, find the `"exports"` map and add an entry mirroring the existing `./empty-lines` entry (same `import`/`types` shape, pointing at `./src/date-mention.ts` and its built output). Match the surrounding entries exactly.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @memry/shared exec vitest run src/date-mention.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/date-mention.ts packages/shared/src/date-mention.test.ts packages/shared/package.json
git commit -m "feat(shared): date-mention token format + computeRemindAt"
```

---

## Task 2: `note_date` reminder target type + `anchorId` column

**Files:**

- Modify: `packages/contracts/src/reminder-types.ts`
- Modify: `packages/db-schema/src/schema/reminders.ts`
- Modify: `packages/contracts/src/inbox-api.ts` (ReminderMetadata)

- [ ] **Step 1: Add `note_date` to the target-type map**

In `packages/contracts/src/reminder-types.ts`, add the member:

```typescript
export const reminderTargetType = {
  NOTE: 'note',
  JOURNAL: 'journal',
  HIGHLIGHT: 'highlight',
  TASK: 'task',
  NOTE_DATE: 'note_date'
} as const
```

- [ ] **Step 2: Propagate the union to any hand-redeclared copies**

Run: `git grep -n "'note' | 'journal' | 'highlight' | 'task'" -- packages apps`
For each file that re-declares the union literally (known drift: `packages/rpc/src/inbox.ts`, `apps/desktop/src/preload` reminder API `.d.ts`, `cli/run.ts`), add `| 'note_date'`. Where a file imports `ReminderTargetType` from `@memry/contracts/reminder-types`, no change is needed.

- [ ] **Step 3: Add the `anchorId` column**

In `packages/db-schema/src/schema/reminders.ts`, inside the `sqliteTable` column object (after `highlightEnd`), add:

```typescript
    /** For 'note_date' reminders: the inline date pill's stable anchor id */
    anchorId: text('anchor_id'),
```

- [ ] **Step 4: Add `anchorId` to ReminderMetadata**

In `packages/contracts/src/inbox-api.ts`, inside `interface ReminderMetadata` (after `highlightEnd`), add:

```typescript
  /** For 'note_date' reminders: the inline date pill's anchor id (scroll target) */
  anchorId?: string
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @memry/desktop db:generate`
Expected: a new migration SQL adding `anchor_id` to `reminders`. (Pre-production: schema is resettable.)

- [ ] **Step 6: Typecheck + contract check**

Run: `pnpm --filter @memry/desktop typecheck:node` then `pnpm ipc:check`
Expected: PASS. Fix any non-exhaustive `switch (targetType)` the compiler flags by adding a `note_date` branch (or letting it fall through to the note-open path).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/reminder-types.ts packages/contracts/src/inbox-api.ts packages/db-schema apps/desktop/src/preload packages/rpc
git commit -m "feat(reminders): add note_date target type + anchorId"
```

---

## Task 3: `dateMention` inline content spec

Mirror `link-mention.ts`. The pill renders a non-editable chip; `toExternalHTML` emits the Task 1 token.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/date-mention.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/date-mention.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// date-mention.test.ts
import { describe, it, expect } from 'vitest'
import { createDateMentionContent, formatDateMentionLabel } from './date-mention'

describe('date-mention content', () => {
  it('builds inline content from token data', () => {
    const c = createDateMentionContent({
      anchorId: 'dm_1',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: true,
      remind: true,
      lead: '1h'
    })
    expect(c.type).toBe('dateMention')
    expect(c.props.anchorId).toBe('dm_1')
    expect(c.props.remind).toBe(true)
  })

  it('formats a date-only label without time', () => {
    const label = formatDateMentionLabel('2026-06-20T00:00:00.000Z', false)
    expect(label).toMatch(/Jun 20/)
    expect(label).not.toMatch(/:/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/date-mention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the spec**

```tsx
// date-mention.tsx
import { createInlineContentSpec } from '@blocknote/core'
import {
  serializeDateMentionToken,
  type DateMentionData,
  type DateMentionLead
} from '@memry/shared/date-mention'

export function formatDateMentionLabel(dateISO: string, hasTime: boolean): string {
  const d = new Date(dateISO)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (!hasTime) return date
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${time}`
}

export function createDateMentionContent(data: DateMentionData) {
  return {
    type: 'dateMention' as const,
    props: {
      anchorId: data.anchorId,
      dateISO: data.dateISO,
      hasTime: data.hasTime,
      remind: data.remind,
      lead: data.lead
    }
  }
}

export const DateMention = createInlineContentSpec(
  {
    type: 'dateMention',
    propSchema: {
      anchorId: { default: '' },
      dateISO: { default: '' },
      hasTime: { default: false },
      remind: { default: false },
      lead: { default: 'at' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const { anchorId, dateISO, hasTime, remind } = inlineContent.props as DateMentionData
      const dom = document.createElement('span')
      dom.className = 'date-mention'
      dom.setAttribute('data-date-mention', '')
      dom.setAttribute('data-anchor-id', anchorId)
      dom.setAttribute('data-date-iso', dateISO)
      dom.setAttribute('data-has-time', String(hasTime))
      dom.setAttribute('data-remind', String(remind))
      dom.setAttribute('data-lead', String((inlineContent.props as DateMentionData).lead))
      dom.setAttribute('contenteditable', 'false')

      const icon = document.createElement('span')
      icon.className = 'date-mention-icon'
      icon.textContent = '📅'
      dom.appendChild(icon)

      const label = document.createElement('span')
      label.className = 'date-mention-label'
      label.textContent = formatDateMentionLabel(dateISO, hasTime)
      dom.appendChild(label)

      if (remind) {
        const bell = document.createElement('span')
        bell.className = 'date-mention-bell'
        bell.textContent = '🔔'
        dom.appendChild(bell)
      }

      return { dom }
    },

    parse: (element) => {
      if (!element.hasAttribute('data-date-mention')) return undefined
      const anchorId = element.getAttribute('data-anchor-id') || ''
      const dateISO = element.getAttribute('data-date-iso') || ''
      if (!anchorId || !dateISO) return undefined
      return {
        anchorId,
        dateISO,
        hasTime: element.getAttribute('data-has-time') === 'true',
        remind: element.getAttribute('data-remind') === 'true',
        lead: (element.getAttribute('data-lead') as DateMentionLead) || 'at'
      }
    },

    toExternalHTML: (inlineContent) => {
      const dom = document.createElement('span')
      dom.textContent = serializeDateMentionToken(inlineContent.props as DateMentionData)
      return { dom }
    }
  }
)
```

- [ ] **Step 4: Register in the editor schema**

In `editor-schema.ts`, import and add to `inlineContentSpecs`:

```typescript
import { DateMention } from './date-mention'
// ...
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikiLink: WikiLink,
    hashTag: HashTag,
    linkMention: LinkMention,
    dateMention: DateMention
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run the date-mention test (Step 2 command) → PASS, then `pnpm --filter @memry/desktop typecheck:web` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/date-mention.tsx apps/desktop/src/renderer/src/components/note/content-area/date-mention.test.ts apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts
git commit -m "feat(notes): dateMention inline content spec"
```

---

## Task 4: Load-time hydrate (`normalizeDateMentions`)

On load, BlockNote parses the `((date:...))` token as plain text. Convert any such text into `dateMention` inline content, mirroring `normalizeLinkMentions`.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts`

- [ ] **Step 1: Read the precedent**

Read `link-mention-utils.ts` fully so the new util matches its block-walking shape and `{ blocks, didChange }` return contract.

- [ ] **Step 2: Write the failing test**

```typescript
// date-mention-utils.test.ts
import { describe, it, expect } from 'vitest'
import type { Block } from '@blocknote/core'
import { normalizeDateMentions } from './date-mention-utils'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

const token = serializeDateMentionToken({
  anchorId: 'dm_1',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  remind: true,
  lead: '1h'
})

function paragraph(text: string): Block {
  return {
    id: 'b1',
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: []
  } as unknown as Block
}

describe('normalizeDateMentions', () => {
  it('replaces a token text node with a dateMention inline content', () => {
    const { blocks, didChange } = normalizeDateMentions([paragraph(`due ${token}`)])
    expect(didChange).toBe(true)
    const content = (blocks[0] as any).content
    const mention = content.find((c: any) => c.type === 'dateMention')
    expect(mention.props.anchorId).toBe('dm_1')
    expect(content[0]).toMatchObject({ type: 'text', text: 'due ' })
  })

  it('returns didChange=false when there is no token', () => {
    const { didChange } = normalizeDateMentions([paragraph('plain text')])
    expect(didChange).toBe(false)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/date-mention-utils.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the hydrate**

```typescript
// date-mention-utils.ts
import type { Block } from '@blocknote/core'
import { DATE_MENTION_TOKEN_REGEX, parseDateMentionToken } from '@memry/shared/date-mention'
import { createDateMentionContent } from './date-mention'

type InlineNode = { type: string; text?: string; styles?: unknown; props?: unknown }

function splitTextNode(node: InlineNode): InlineNode[] {
  if (node.type !== 'text' || typeof node.text !== 'string') return [node]
  const text = node.text
  const regex = new RegExp(DATE_MENTION_TOKEN_REGEX.source, 'g')
  const out: InlineNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const data = parseDateMentionToken(m[1])
    if (!data) continue
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index), styles: node.styles })
    }
    out.push(createDateMentionContent(data) as unknown as InlineNode)
    last = m.index + m[0].length
  }
  if (last === 0) return [node]
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last), styles: node.styles })
  }
  return out
}

export function normalizeDateMentions(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  let didChange = false

  const walk = (block: Block): Block => {
    let next = block
    const content = (block as { content?: InlineNode[] }).content
    if (Array.isArray(content)) {
      const rebuilt = content.flatMap((node) => {
        const parts = splitTextNode(node)
        if (parts.length !== 1 || parts[0] !== node) didChange = true
        return parts
      })
      if (didChange) next = { ...block, content: rebuilt } as Block
    }
    const children = (block.children ?? []) as Block[]
    if (children.length) {
      const nextChildren = children.map(walk)
      if (nextChildren.some((c, i) => c !== children[i])) {
        next = { ...next, children: nextChildren } as Block
      }
    }
    return next
  }

  const out = blocks.map(walk)
  return { blocks: didChange ? out : blocks, didChange }
}
```

- [ ] **Step 5: Wire into the load path**

In `hooks/use-editor-sync.ts`, find each place that calls `normalizeLinkMentions(...).blocks` (or the imported alias) and chain the date normalize on the same `normalizedBlocks` variable, e.g.:

```typescript
import { normalizeDateMentions } from '../date-mention-utils'
// after the existing normalizeLinkMentions assignment:
normalizedBlocks = normalizeDateMentions(normalizedBlocks).blocks
```

Apply at both call sites (there are two).

- [ ] **Step 6: Run tests + typecheck**

Run the util test (Step 3 command) → PASS, then `pnpm --filter @memry/desktop typecheck:web` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.ts apps/desktop/src/renderer/src/components/note/content-area/date-mention-utils.test.ts apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts
git commit -m "feat(notes): hydrate date-mention tokens on load"
```

---

## Task 5: Picker popover + `/date` slash item

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/date-mention-popover.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`

- [ ] **Step 1: Read the date-picker precedent**

Read `apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx` for the existing date/time picker primitive and its props (per the CLAUDE.md gotcha note, this file is the canonical picker example). Reuse that calendar/time primitive in the popover rather than inventing one.

- [ ] **Step 2: Build the popover component**

Create `date-mention-popover.tsx` exporting `DateMentionPopover`. Props:

```typescript
interface DateMentionPopoverProps {
  open: boolean
  anchorEl: HTMLElement | null
  value: { dateISO: string; hasTime: boolean; remind: boolean; lead: DateMentionLead }
  onChange: (next: DateMentionPopoverProps['value']) => void
  onClose: () => void
}
```

Contents: the date/time picker primitive from Step 1; a "Remind me" toggle bound to `remind`; a lead `<select>` (disabled unless `remind`) with options `at` ("At time"), `5m` ("5 minutes before"), `1h` ("1 hour before"), `1d` ("1 day before"). Use `@/components/ui/picker`-family primitives for the popover surface. Match the Tailwind **logical** class rules (`ms-`/`ps-`/`start-`, never `ml-`/`pl-`/`left-`). Every change calls `onChange` with the full value object.

- [ ] **Step 3: Add the `/date` slash item**

In `ContentArea.tsx`, the slash `SuggestionMenuController` `getItems` (around line 977) builds `defaults = getDefaultReactSlashMenuItems(editor)` and appends custom items (e.g. `getTaskSlashMenuItem(editor)`). Add a sibling "Date" item, in the "Basic blocks" group, that on select:

1. generates `anchorId` via the app's id helper (use the same id util the editor already imports; if none, `crypto.randomUUID()` prefixed `dm_`),
2. inserts a `dateMention` inline content at the cursor with `createDateMentionContent({ anchorId, dateISO: <today 09:00 ISO>, hasTime: false, remind: false, lead: 'at' })` using `editor.insertInlineContent([...])`,
3. opens `DateMentionPopover` anchored to the new pill so the user sets the date immediately.

Keep slash groups contiguous (the existing `orderSlashMenuItemsByGroup` helper handles ordering — append in the same place task/callout items are appended).

- [ ] **Step 4: Wire pill click → popover**

In `ContentArea.tsx` (or the editor container that owns DOM listeners), add a delegated click handler: when a `[data-date-mention]` element is clicked, read its `data-anchor-id`, find the matching `dateMention` inline content, and open `DateMentionPopover` with its current props. On `onChange`, update the inline content via the editor's update API (find the node by `anchorId` and `editor.updateInlineContent`/equivalent). Guard against editor-zone mousedown stealing focus per the BlockNote focus-guard gotcha (exclude `.bn-*`/menu nodes; the pill is `contenteditable=false`).

- [ ] **Step 5: Renderer test (smoke)**

Add a test that renders the popover with a fixed `value`, toggles "Remind me", and asserts `onChange` fires with `remind: true`. Mock `@/components/ui/picker` per the Picker-in-jsdom convention (it won't open on click in jsdom).

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/date-mention-popover.test.tsx`
Expected: PASS.

- [ ] **Step 6: Manual smoke (dev)**

Run `pnpm --filter @memry/desktop dev:a`, open a note, type `/date`, confirm the pill inserts and the popover opens; set a date+time, toggle remind, reload the note, confirm the pill persists (token round-trip).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/date-mention-popover.tsx apps/desktop/src/renderer/src/components/note/content-area/date-mention-popover.test.tsx apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "feat(notes): /date slash item + date-mention picker popover"
```

---

## Task 6: Derive bridge — tokens → `note_date` reminder rows

Parse `((date:...))` tokens out of a note's raw markdown and reconcile `note_date` reminder rows for that note: create for new reminding pills, update on change, delete when removed or `remind:false`.

**Files:**

- Create: `apps/desktop/src/main/notes/note-date-reminders.ts`
- Test: `apps/desktop/src/main/notes/note-date-reminders.test.ts`
- Modify: `apps/desktop/src/main/vault/notes-crud.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// note-date-reminders.test.ts
import { describe, it, expect, vi } from 'vitest'
import { syncNoteDateReminders } from './note-date-reminders'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

function fakeService(existing: any[] = []) {
  const rows = [...existing]
  return {
    rows,
    list: vi.fn(async () => ({ reminders: rows, total: rows.length, hasMore: false })),
    create: vi.fn(async (input: any) => {
      const row = { id: `rem_${rows.length}`, status: 'pending', ...input }
      rows.push(row)
      return row
    }),
    update: vi.fn(async (input: any) => {
      const r = rows.find((x) => x.id === input.id)
      Object.assign(r, input)
      return r
    }),
    delete: vi.fn(async (id: string) => {
      const i = rows.findIndex((x) => x.id === id)
      if (i >= 0) rows.splice(i, 1)
      return true
    })
  }
}

const remindingToken = serializeDateMentionToken({
  anchorId: 'dm_1',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  remind: true,
  lead: '1h'
})

describe('syncNoteDateReminders', () => {
  it('creates a note_date reminder for a new reminding pill', async () => {
    const svc = fakeService()
    await syncNoteDateReminders('note_1', `due ${remindingToken}`, svc as any)
    expect(svc.create).toHaveBeenCalledTimes(1)
    expect(svc.rows[0]).toMatchObject({
      targetType: 'note_date',
      targetId: 'note_1',
      anchorId: 'dm_1',
      remindAt: '2026-06-20T08:00:00.000Z'
    })
  })

  it('does NOT create a row for a bare (remind:false) date', async () => {
    const bare = serializeDateMentionToken({
      anchorId: 'dm_2',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: false,
      remind: false,
      lead: 'at'
    })
    const svc = fakeService()
    await syncNoteDateReminders('note_1', bare, svc as any)
    expect(svc.create).not.toHaveBeenCalled()
  })

  it('deletes the row when the pill is removed from the note', async () => {
    const svc = fakeService([
      { id: 'rem_x', targetType: 'note_date', targetId: 'note_1', anchorId: 'dm_1', remindAt: 'x' }
    ])
    await syncNoteDateReminders('note_1', 'no dates here', svc as any)
    expect(svc.delete).toHaveBeenCalledWith('rem_x')
  })

  it('updates remindAt when the pill date changes', async () => {
    const svc = fakeService([
      {
        id: 'rem_x',
        targetType: 'note_date',
        targetId: 'note_1',
        anchorId: 'dm_1',
        remindAt: '2000-01-01T00:00:00.000Z'
      }
    ])
    await syncNoteDateReminders('note_1', `due ${remindingToken}`, svc as any)
    expect(svc.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rem_x', remindAt: '2026-06-20T08:00:00.000Z' })
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/notes/note-date-reminders.test.ts`
Expected: FAIL — module not found.

> If you see `ERR_DLOPEN_FAILED` / NODE_MODULE_VERSION, run `pnpm --filter @memry/desktop rebuild:node` first.

- [ ] **Step 3: Implement the derive bridge**

```typescript
// note-date-reminders.ts
import {
  DATE_MENTION_TOKEN_REGEX,
  parseDateMentionToken,
  computeRemindAt
} from '@memry/shared/date-mention'
import type { RemindersService } from '@memry/app-core/reminders'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteDateReminders')

/**
 * Reconcile note_date reminder rows for a note against the date pills in its
 * markdown. Only pills with remind:true produce rows. Idempotent: safe to run
 * on every note write.
 */
export async function syncNoteDateReminders(
  noteId: string,
  markdown: string,
  service: RemindersService
): Promise<void> {
  // Desired rows keyed by anchorId (reminding pills only).
  const desired = new Map<string, { remindAt: string }>()
  for (const m of markdown.matchAll(DATE_MENTION_TOKEN_REGEX)) {
    const data = parseDateMentionToken(m[1])
    if (!data || !data.remind) continue
    desired.set(data.anchorId, { remindAt: computeRemindAt(data.dateISO, data.lead) })
  }

  const existingList = await service.list({
    targetType: 'note_date',
    targetId: noteId,
    limit: 1000
  })
  const existingByAnchor = new Map<string, (typeof existingList.reminders)[number]>()
  for (const row of existingList.reminders) {
    if (row.anchorId) existingByAnchor.set(row.anchorId, row)
  }

  // Create or update.
  for (const [anchorId, want] of desired) {
    const row = existingByAnchor.get(anchorId)
    if (!row) {
      await service.create({
        targetType: 'note_date',
        targetId: noteId,
        anchorId,
        remindAt: want.remindAt
      })
    } else if (row.remindAt !== want.remindAt) {
      await service.update({ id: row.id, remindAt: want.remindAt })
    }
  }

  // Delete rows whose pill is gone or no longer reminding.
  for (const [anchorId, row] of existingByAnchor) {
    if (!desired.has(anchorId)) {
      await service.delete(row.id)
    }
  }

  log.debug('Synced note_date reminders', { noteId, desired: desired.size })
}
```

> `CreateReminderInput`/`UpdateReminderInput` and `RemindersService` come from `@memry/app-core/reminders` (Task references confirm `create`, `update`, `delete`, `list` signatures). Add `anchorId` to `CreateReminderInput` in `packages/app-core/src/reminders.ts` and to the `create()` `.values({...})` insert, since the service currently has no `anchorId` field.

- [ ] **Step 4: Extend RemindersService for `anchorId`**

In `packages/app-core/src/reminders.ts`: add `anchorId?: string | null` to `CreateReminderInput` and `ReminderRecord`; include `anchorId: input.anchorId ?? null` in the `create()` insert `.values({...})` and `anchorId: row.anchorId` in `toReminder()`. Add the same `anchorId` field to the contracts `Reminder`/`ReminderWithTarget` (`packages/contracts/src/reminders-api.ts`) and `ReminderRecord`.

- [ ] **Step 5: Run the derive test**

Run the Step 2 command → PASS (4 tests). Run `pnpm --filter @memry/shared test` is not needed here.

- [ ] **Step 6: Wire into note write/delete**

In `apps/desktop/src/main/vault/notes-crud.ts`:

- In `createNote` (after the note file is written, near `emitNoteEvent(...CREATED...)`) and `updateNote` (after `newContent` is persisted, near `emitNoteEvent(...UPDATED...)`), call `await syncNoteDateReminders(note.id, <markdown content>, remindersService)`. Use the same RemindersService instance the main process already constructs (locate it where other reminder operations are invoked; if not readily injectable, import the service factory used by `apps/desktop/src/main/lib/reminders.ts`). Pass the note's markdown body (the `content`/`newContent` variable).
- In the note delete path, call `service.list({ targetType: 'note_date', targetId: id })` then `service.delete(...)` for each (or add a small `clearNoteDateReminders(noteId, service)` helper in `note-date-reminders.ts`). Wrap in try/catch + `log.warn` so a reminder failure never breaks the note write.

- [ ] **Step 7: Typecheck + main tests**

Run: `pnpm --filter @memry/desktop typecheck:node` and `pnpm --filter @memry/desktop test:main`
Expected: PASS (existing reminders.test.ts still green; new test green).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/notes/note-date-reminders.ts apps/desktop/src/main/notes/note-date-reminders.test.ts apps/desktop/src/main/vault/notes-crud.ts packages/app-core/src/reminders.ts packages/contracts/src/reminders-api.ts
git commit -m "feat(reminders): derive note_date reminders from note date pills"
```

---

## Task 7: Carry `anchorId` through nav + scroll to the pill

A fired `note_date` reminder becomes an inbox item; clicking it must open the note and scroll to `[data-anchor-id]`.

**Files:**

- Modify: `apps/desktop/src/main/lib/reminders.ts` (metadata builder)
- Modify: `apps/desktop/src/renderer/src/lib/reminder-panel.ts` (ReminderEntryNav)
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx` (scroll-to)

- [ ] **Step 1: Put `anchorId` into ReminderMetadata when firing**

In `apps/desktop/src/main/lib/reminders.ts`, find where a due reminder is turned into an inbox item / `ReminderMetadata` (the function the existing test describes as "lands a … reminder with … notification"). Add `anchorId: reminder.anchorId ?? undefined` to the metadata object. For `targetType === 'note_date'`, set `targetId` to the noteId (already is) so the existing note-open path resolves the title.

- [ ] **Step 2: Carry `anchorId` in ReminderEntryNav**

In `apps/desktop/src/renderer/src/lib/reminder-panel.ts`:

- Add `anchorId?: string` to `interface ReminderEntryNav`.
- In `reminderToNav`, add `anchorId: r.anchorId ?? undefined` (requires `anchorId` on `ReminderWithTarget` from Task 6 Step 4).
- In `metadataToNav`, add `anchorId: m.anchorId`.

- [ ] **Step 3: Write the failing scroll test**

In a renderer test for `note.tsx` (or a small extracted helper `scrollToAnchor(anchorId)`), assert that given a nav with `anchorId: 'dm_1'` and a DOM containing `<span data-anchor-id="dm_1">`, the helper calls `scrollIntoView` on that element. Prefer extracting a pure helper:

```typescript
// in note.tsx (exported for test) or a sibling util
export function scrollToAnchor(container: HTMLElement, anchorId: string): boolean {
  const el = container.querySelector(`[data-anchor-id="${CSS.escape(anchorId)}"]`)
  if (!el) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return true
}
```

Test:

```typescript
it('scrolls to the pill with the matching anchorId', () => {
  const root = document.createElement('div')
  const pill = document.createElement('span')
  pill.setAttribute('data-anchor-id', 'dm_1')
  pill.scrollIntoView = vi.fn()
  root.appendChild(pill)
  expect(scrollToAnchor(root, 'dm_1')).toBe(true)
  expect(pill.scrollIntoView).toHaveBeenCalled()
})
```

- [ ] **Step 4: Wire the scroll into note open**

In `note.tsx`, where the reminder nav is consumed (the existing `highlightStart` handling found by grep), add: if `nav.anchorId` is present, after the editor mounts/content loads, call `scrollToAnchor(editorContainerEl, nav.anchorId)`; fall back to the existing highlight-offset path when `anchorId` is absent. Use the existing "after load" timing the highlight path already uses.

- [ ] **Step 5: Run tests + typechecks**

Run the scroll test (renderer project) → PASS. Then `pnpm --filter @memry/desktop typecheck:web` and `typecheck:node` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/lib/reminders.ts apps/desktop/src/renderer/src/lib/reminder-panel.ts apps/desktop/src/renderer/src/pages/note.tsx
git commit -m "feat(reminders): scroll to date pill via anchorId on reminder open"
```

---

## Task 8: Full verification pass

- [ ] **Step 1: Targeted suites**

```bash
pnpm --filter @memry/shared test
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop test:main
```

Expected: all green (note the known d1/websocket pre-existing flakes are unrelated).

- [ ] **Step 2: Types, lint, contracts, IPC**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck:node
pnpm lint
pnpm ipc:generate && pnpm ipc:check
git diff --check
```

Expected: all clean.

- [ ] **Step 3: Manual end-to-end (dev)**

`pnpm --filter @memry/desktop dev:a`: insert `/date`, set a near-future time with "Remind me" + `at time`, wait for it to fire, confirm an Inbox reminder item appears, click it, confirm the note opens and scrolls to the pill. Remove the pill, save, confirm the reminder row is gone (no future fire).

- [ ] **Step 4: Docs gate (before any push/PR)**

This touches desktop + contracts. Run `pnpm docs:ai-update --base <base_commit>` or update `apps/docs/src` manually, then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`. If intentionally non-docs, use `MEMRY_DOCS_IMPACT_SKIP=1` with a one-line reason.

---

## Phase 2 (separate plan — not in this MVP)

- Surface `note_date` rows (bare + reminding) as **read-only** calendar entries via a new `CalendarSyncSourceType` (`calendar/types.ts` already has a reminder-derived source); click → open note at the pill.
- Optional natural-language entry (`/date tomorrow 9am`) reusing `apps/desktop/src/renderer/src/lib/natural-date-parser.ts`.
- Recurring reminders; timezone selection.

---

## Self-review notes

- **Spec coverage:** insert/pill (T3,T5), bare vs reminding (T1,T6), fire→inbox (T6+existing engine), open→scroll (T7), edit/remove (T5,T6), persistence (T1,T3,T4), `note_date` type + `anchorId` (T2,T6). Calendar = Phase 2 per spec.
- **anchorId on paste:** copy/paste of a pill duplicates `anchorId`; the derive `Map<anchorId>` makes it last-write-wins (one row per anchorId). Acceptable for MVP; regenerate-on-paste is a Phase-2 polish.
- **Cross-device derive:** T6 wires derive at the local note-write chokepoint. Deriving on inbound CRDT apply (so a synced pill fires on the receiving device) is an explicit follow-up — confirm/extend the CRDT writeback path; not required for single-device MVP.
