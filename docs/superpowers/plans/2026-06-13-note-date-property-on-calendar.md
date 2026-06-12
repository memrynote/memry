# Note Date Property on Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a note has a `date`-typed property flagged "Show on calendar", surface that note as an all-day chip on its date in the calendar view; clicking the chip opens the note.

**Architecture:** Add a new derived calendar source — notes with a calendar-enabled date property — alongside the existing five (`projection.ts`). The opt-in flag is vault-wide and **synced across devices**: it lives in `.memry/properties.md` via `PropertyDefinitionsService` (extended to track `date` entries with a `showOnCalendar` flag). The projection takes the list of enabled property names from that service — so there is **no new DB table, column, or migration**. The flag is toggled from a new inline menu on date-property rows in the note. v1 is read-only (no drag-to-reschedule).

**Tech Stack:** Electron + React 19 + Vite, Drizzle ORM (better-sqlite3, dual data/index DBs), Zod contracts, RPC codegen, Vitest.

**Branch:** `note-date-property-calendar` (code-context name, per CLAUDE.md).

**Decided:** flag is synced via `properties.md` (not device-local).

---

## File Structure

**New files:**

- `apps/desktop/src/renderer/src/hooks/use-calendar-properties.ts` — renderer state for the toggle (fetch-once cache + optimistic setter).
- `apps/desktop/src/renderer/src/components/calendar/calendar-note-popover.tsx` — chip-click popover for notes.

**Modified files:**

- `packages/contracts/src/property-types.ts` — add `showOnCalendar` to `PropertyDefinition` + a `date` variant to the file schema.
- `apps/desktop/src/main/vault/property-definitions.ts` — persist/parse date entries; `setShowOnCalendar` + `listCalendarEnabledNames`.
- `packages/contracts/src/calendar-api.ts` — add `'note'` to source/visual enums.
- `packages/contracts/src/ipc-channels.ts` — add two Notes channels.
- `packages/rpc/src/notes.ts` — add `setCalendarPropertyVisibility` + `getCalendarPropertyNames` methods.
- `apps/desktop/src/main/calendar/projection.ts` — add `loadNoteDatePropertyItems`, thread `IndexDb` + `enabledNames`.
- `apps/desktop/src/main/ipc/calendar-handlers.ts` — pass index DB + enabled names into the projection.
- `apps/desktop/src/main/ipc/notes-handlers.ts` — register the two new handlers (service-backed).
- `apps/desktop/src/renderer/src/lib/event-type-colors.ts` — add `note` color.
- `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx` — add `note` icon.
- `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx` — inline "Show on calendar" menu on date rows.
- `apps/desktop/src/renderer/src/components/calendar/calendar-page.tsx` — route `note` chips to the new popover.
- `packages/i18n/src/locales/en/notes.json` + `calendar.json` — menu + popover strings.

---

## Task 1: Persist the flag in properties.md (contract + service)

**Files:**

- Modify: `packages/contracts/src/property-types.ts`
- Modify: `apps/desktop/src/main/vault/property-definitions.ts`
- Test: `apps/desktop/src/main/vault/property-definitions.test.ts` (create or extend)

- [ ] **Step 1: Extend the contract type + file schema**

In `property-types.ts`:

Add `showOnCalendar` to the `PropertyDefinition` interface (after `defaultValue`, line 37):

```ts
export interface PropertyDefinition {
  name: string
  type: PropertyType
  options?: SelectOption[]
  categories?: StatusCategories
  defaultValue?: string
  showOnCalendar?: boolean
}
```

Add a date variant and include it in the discriminated union (after `MultiselectPropertySchema`, line 90):

```ts
const DatePropertySchema = z.object({
  type: z.literal('date'),
  showOnCalendar: z.boolean().optional()
})

export const PropertyDefinitionSchema = z.discriminatedUnion('type', [
  StatusPropertySchema,
  SelectPropertySchema,
  MultiselectPropertySchema,
  DatePropertySchema
])
```

- [ ] **Step 2: Write the failing service test**

`property-definitions.test.ts` — drive the service against a temp vault dir (the service's `rebuildDbCache` swallows missing-DB errors via its own try/catch, so no DB is needed):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PropertyDefinitionsService } from './property-definitions'

describe('PropertyDefinitionsService — showOnCalendar', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'memry-propdefs-'))
    mkdirSync(join(vault, '.memry'), { recursive: true })
  })

  it('enables, persists, reloads, and disables a date property flag', async () => {
    const svc = PropertyDefinitionsService.init(vault)
    expect(svc.listCalendarEnabledNames()).toEqual([])

    await svc.setShowOnCalendar('Deadline', true)
    expect(svc.listCalendarEnabledNames()).toEqual(['Deadline'])

    // round-trips through properties.md
    await svc.reload()
    expect(svc.listCalendarEnabledNames()).toEqual(['Deadline'])

    await svc.setShowOnCalendar('Deadline', false)
    expect(svc.listCalendarEnabledNames()).toEqual([])
    await svc.reload()
    expect(svc.listCalendarEnabledNames()).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm --filter @memry/desktop test:main property-definitions`
Expected: FAIL — `setShowOnCalendar` / `listCalendarEnabledNames` don't exist.

- [ ] **Step 4: Implement service support**

In `property-definitions.ts`:

`applyParsedData` (line 190) — add a `date` branch:

```ts
private applyParsedData(data: PropertyDefinitionsFileData): void {
  this.cache.clear()
  for (const [name, def] of Object.entries(data.properties)) {
    if (def.type === 'status') {
      this.cache.set(name, { name, type: 'status', categories: def.categories })
    } else if (def.type === 'date') {
      this.cache.set(name, { name, type: 'date', showOnCalendar: def.showOnCalendar })
    } else {
      this.cache.set(name, { name, type: def.type, options: def.options })
    }
  }
}
```

`persistToFile` (line 201) — add a `date` branch:

```ts
for (const [name, def] of this.cache) {
  if (def.type === 'status') {
    properties[name] = { type: 'status', categories: def.categories }
  } else if (def.type === 'date') {
    properties[name] = { type: 'date', showOnCalendar: def.showOnCalendar ?? true }
  } else {
    properties[name] = { type: def.type, options: def.options }
  }
}
```

Add two public methods (next to `upsert`/`remove`):

```ts
async setShowOnCalendar(name: string, show: boolean): Promise<void> {
  await this.enqueueWrite(async () => {
    const existing = this.cache.get(name)
    if (show) {
      this.cache.set(name, { ...(existing ?? { name, type: 'date' }), name, showOnCalendar: true })
    } else if (existing?.type === 'date') {
      // date entries only carry the calendar flag → drop the entry when off
      this.cache.delete(name)
    } else if (existing) {
      this.cache.set(name, { ...existing, showOnCalendar: false })
    }
    await this.persistToFile()
    this.rebuildDbCache()
  })
}

listCalendarEnabledNames(): string[] {
  return Array.from(this.cache.values())
    .filter((def) => def.showOnCalendar === true)
    .map((def) => def.name)
}
```

> `rebuildSingleDbCache` (line 227) iterates the cache and inserts `propertyDefinitions` rows; a date entry now produces a harmless `{type:'date', options:null}` row — no schema/column change needed there, and the projection does not read it.

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @memry/desktop test:main property-definitions`
Expected: PASS.

- [ ] **Step 6: Typecheck contracts** (the new union variant may surface exhaustive switches on `PropertyDefinitionSchema`)

Run: `pnpm --filter @memry/contracts typecheck && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS. Fix any non-exhaustive handling of the `date` variant.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/property-types.ts apps/desktop/src/main/vault/property-definitions.ts apps/desktop/src/main/vault/property-definitions.test.ts
git commit -m "feat(notes): persist showOnCalendar date-property flag in properties.md"
```

---

## Task 2: Projection — derive note items from enabled date properties

**Files:**

- Modify: `apps/desktop/src/main/calendar/projection.ts`
- Test: `apps/desktop/src/main/calendar/projection.test.ts` (add cases; if absent, create following the existing main-test harness)

- [ ] **Step 1: Write the failing projection test**

Seed an index DB with `note_cache` (id `n1`, title `Q3 Launch`) + `note_properties` (name `Deadline`, type `date`, value `2026-06-20T00:00:00.000Z`). Pass `enabledNames` explicitly:

```ts
it('projects notes with an enabled date property', () => {
  const { items } = getCalendarRangeProjection(
    dataDb,
    indexDb,
    {
      startAt: '2026-06-01T00:00:00.000Z',
      endAt: '2026-07-01T00:00:00.000Z',
      includeUnselectedSources: false
    },
    ['Deadline']
  )

  const note = items.find((i) => i.sourceType === 'note')
  expect(note).toBeDefined()
  expect(note!.title).toBe('Q3 Launch')
  expect(note!.visualType).toBe('note')
  expect(note!.isAllDay).toBe(true)
  expect(note!.projectionId).toBe('note:n1:Deadline')
  expect(note!.descriptionPreview).toBe('Deadline')
  expect(note!.editability).toEqual({
    canMove: false,
    canResize: false,
    canEditText: false,
    canDelete: false
  })
})

it('omits the note when its property is not in enabledNames', () => {
  const { items } = getCalendarRangeProjection(
    dataDb,
    indexDb,
    {
      startAt: '2026-06-01T00:00:00.000Z',
      endAt: '2026-07-01T00:00:00.000Z',
      includeUnselectedSources: false
    },
    []
  )
  expect(items.some((i) => i.sourceType === 'note')).toBe(false)
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @memry/desktop test:main projection`
Expected: FAIL — `getCalendarRangeProjection` takes 3 args / no `note` items.

- [ ] **Step 3: Add the loader + thread IndexDb + enabledNames**

In `projection.ts`:

Imports (extend the existing `'../database'` type import to add `IndexDb`):

```ts
import { noteCache, noteProperties } from '@memry/db-schema/schema/notes-cache'
import type { DataDb, IndexDb } from '../database'
```

Add the loader (after `loadExternalEvents`):

```ts
function loadNoteDatePropertyItems(
  indexDb: IndexDb,
  enabledNames: string[],
  input: GetCalendarRangeInput
): CalendarProjectionItem[] {
  if (enabledNames.length === 0) return []

  const rows = indexDb
    .select({
      noteId: noteProperties.noteId,
      name: noteProperties.name,
      value: noteProperties.value,
      title: noteCache.title
    })
    .from(noteProperties)
    .innerJoin(noteCache, eq(noteProperties.noteId, noteCache.id))
    .where(
      and(
        inArray(noteProperties.name, enabledNames),
        eq(noteProperties.type, 'date'),
        isNotNull(noteProperties.value),
        gte(noteProperties.value, input.startAt),
        lt(noteProperties.value, input.endAt)
      )
    )
    .all()

  const editability: CalendarProjectionEditability = {
    canMove: false,
    canResize: false,
    canEditText: false,
    canDelete: false
  }

  return rows.flatMap((row) => {
    const parsed = new Date(row.value!)
    if (Number.isNaN(parsed.getTime())) return []
    const dateStr = toLocalDateString(parsed)
    return [
      {
        projectionId: `note:${row.noteId}:${row.name}`,
        sourceType: 'note',
        sourceId: row.noteId,
        title: row.title,
        descriptionPreview: row.name, // property name → shown in popover ("Deadline · date")
        startAt: toLocalInstant(dateStr, null),
        endAt: toLocalAllDayEnd(dateStr),
        isAllDay: true,
        timezone: LOCAL_TIMEZONE,
        visualType: 'note',
        editability,
        source: nativeSource('memrynote Notes'),
        binding: null,
        snoozeOffsetMinutes: null
      }
    ]
  })
}
```

Change the exported function signature + aggregation:

```ts
export function getCalendarRangeProjection(
  db: DataDb,
  indexDb: IndexDb,
  input: GetCalendarRangeInput,
  enabledNames: string[]
): CalendarRangeResponse {
  const items = sortProjectionItems([
    ...loadMemryEvents(db, input),
    ...loadTaskItems(db, input),
    ...loadReminderItems(db, input),
    ...loadInboxSnoozeItems(db, input),
    ...loadExternalEvents(db, input),
    ...loadNoteDatePropertyItems(indexDb, enabledNames, input)
  ])
  return { items }
}
```

> `value`/`startAt`/`endAt` are ISO strings; `serializeValue` stores date props raw (no JSON quotes), so lexicographic range compare is valid. Assumes date values are ISO 8601 or `YYYY-MM-DD` (the only formats the editor / inference produce).

- [ ] **Step 4: Run the test, verify it passes** (the `'note'` literal won't typecheck until Task 3 — that's expected; run the unit test now to confirm logic; full typecheck is Task 7.)

Run: `pnpm --filter @memry/desktop test:main projection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/projection.ts apps/desktop/src/main/calendar/projection.test.ts
git commit -m "feat(calendar): project notes with enabled date properties"
```

---

## Task 3: Contracts enum + chip visuals + handler wiring

**Files:**

- Modify: `packages/contracts/src/calendar-api.ts`
- Modify: `apps/desktop/src/renderer/src/lib/event-type-colors.ts`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx`
- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts`

- [ ] **Step 1: Add `'note'` to both enums**

In `calendar-api.ts`, add `'note'` to `CalendarProjectionSourceTypeSchema` (line 10) and `CalendarProjectionVisualTypeSchema` (line 17):

```ts
// source type enum → append:  'note'
// visual type enum → append:  'note'
```

- [ ] **Step 2: Add the note color**

In `event-type-colors.ts` `EVENT_TYPE_COLORS`:

```ts
  external_event: '#9A9CFF',
  note: '#E0A458'
```

(Amber/clay — distinct from green task / teal event / blue reminder / periwinkle external. Kaan may tweak the hex.)

- [ ] **Step 3: Add the note icon**

In `calendar-item-chip.tsx`, import a document icon and add to `VISUAL_TYPE_ICONS`:

```ts
import { AlarmClock, Calendar2, CheckSquare3, FileText, NotificationSnooze } from '@/lib/icons'
// ...
  external_event: Calendar2,
  note: FileText
```

> Verify `FileText` is exported from `@/lib/icons`; if not, pick the nearest document glyph. `grep -n "FileText\|Document\|FileText3" apps/desktop/src/renderer/src/lib/icons.ts`.

- [ ] **Step 4: Pass index DB + enabled names into the projection**

In `calendar-handlers.ts`:

- Import `getIndexDatabase` (add to the existing `'../database'` import alongside `requireDatabase`).
- Add a safe getter for enabled names near the top of the file:

```ts
function getCalendarEnabledPropertyNames(): string[] {
  try {
    return PropertyDefinitionsService.get().listCalendarEnabledNames()
  } catch {
    return []
  }
}
```

(Import the service: `import { PropertyDefinitionsService } from '../vault/property-definitions'` — confirm path; the file may prefer a dynamic import, but a static import is fine here since the service is initialized at vault load.)

- Update the GET_RANGE handler (line 509):

```ts
return getCalendarRangeProjection(
  requireDatabase(),
  getIndexDatabase(),
  input,
  getCalendarEnabledPropertyNames()
)
```

- [ ] **Step 5: Typecheck to surface other exhaustive switches**

Run: `pnpm --filter @memry/desktop typecheck`
Expected: PASS. Any other `Record<...visualType...>` / `switch (sourceType)` that's non-exhaustive is flagged by TS — handle each `note` case. Fix until green.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/calendar-api.ts apps/desktop/src/renderer/src/lib/event-type-colors.ts apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx apps/desktop/src/main/ipc/calendar-handlers.ts
git commit -m "feat(calendar): add 'note' source/visual type + chip visuals + projection wiring"
```

---

## Task 4: IPC plumbing — toggle write + read (service-backed)

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/rpc/src/notes.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Then regenerate: `pnpm ipc:generate`

- [ ] **Step 1: Add channels**

In `ipc-channels.ts`, in the Notes `invoke` map (near the `*_PROPERTY_DEFINITION` channels):

```ts
    SET_CALENDAR_PROPERTY_VISIBILITY: 'notes:set-calendar-property-visibility',
    GET_CALENDAR_PROPERTY_NAMES: 'notes:get-calendar-property-names',
```

> Match the exact surrounding key/value style.

- [ ] **Step 2: Add RPC methods**

In `packages/rpc/src/notes.ts`, in `notesRpc.methods` (after `deletePropertyDefinition`, ~line 481):

```ts
    setCalendarPropertyVisibility: defineMethod<
      (name: string, showOnCalendar: boolean) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.SET_CALENDAR_PROPERTY_VISIBILITY,
      params: ['name', 'showOnCalendar'],
      invokeArgs: ['{ name, showOnCalendar }']
    }),
    getCalendarPropertyNames: defineMethod<() => Promise<string[]>>({
      channel: NotesChannels.invoke.GET_CALENDAR_PROPERTY_NAMES
    }),
```

- [ ] **Step 3: Add main handlers (service-backed)**

In `notes-handlers.ts`, register near the other property-definition handlers (~line 507). The select-type handlers already `await import('../vault/property-definitions')` — mirror that:

```ts
registerCommand(
  NotesChannels.invoke.SET_CALENDAR_PROPERTY_VISIBILITY,
  z.object({ name: z.string().min(1), showOnCalendar: z.boolean() }),
  async (input) => {
    const { PropertyDefinitionsService } = await import('../vault/property-definitions')
    await PropertyDefinitionsService.get().setShowOnCalendar(input.name, input.showOnCalendar)
    return { success: true as const }
  },
  'Failed to set calendar property visibility'
)

ipcMain.handle(
  NotesChannels.invoke.GET_CALENDAR_PROPERTY_NAMES,
  createHandler(async () => {
    const { PropertyDefinitionsService } = await import('../vault/property-definitions')
    return PropertyDefinitionsService.get().listCalendarEnabledNames()
  })
)
```

> Confirm `registerCommand` arity and `createHandler` against the existing `CREATE_PROPERTY_DEFINITION` / `GET_PROPERTY_DEFINITIONS` registrations.

- [ ] **Step 4: Regenerate the invoke map + verify**

Run: `pnpm ipc:generate` then `pnpm ipc:check`
Expected: regenerated `generated-rpc.ts` / `index.d.ts` include both methods; `ipc:check` passes.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck`
Expected: PASS — `notesService.setCalendarPropertyVisibility` / `getCalendarPropertyNames` exist on the renderer client.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts packages/rpc/src/notes.ts apps/desktop/src/main/ipc/notes-handlers.ts apps/desktop/src/preload
git commit -m "feat(notes): IPC to toggle + read calendar-enabled date properties"
```

---

## Task 5: Inline "Show on calendar" toggle on date-property rows

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-calendar-properties.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.test.tsx` (create or extend)

- [ ] **Step 1: Write the renderer hook**

`use-calendar-properties.ts` — fetch enabled names once; expose `isEnabled(name)` + optimistic `setEnabled(name, show)`:

```ts
import { useState, useEffect, useCallback } from 'react'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:CalendarProperties')

export function useCalendarProperties() {
  const [names, setNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void notesService
      .getCalendarPropertyNames()
      .then((list) => {
        if (!cancelled) setNames(new Set(list))
      })
      .catch((err) => log.error('Failed to load calendar property names', err))
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (name: string, show: boolean) => {
    setNames((prev) => {
      const next = new Set(prev)
      if (show) next.add(name)
      else next.delete(name)
      return next
    })
    try {
      await notesService.setCalendarPropertyVisibility(name, show)
    } catch (err) {
      log.error('Failed to set calendar property visibility', err)
      setNames((prev) => {
        const next = new Set(prev)
        if (show) next.delete(name)
        else next.add(name)
        return next
      })
    }
  }, [])

  const isEnabled = useCallback((name: string) => names.has(name), [names])

  return { isEnabled, setEnabled }
}
```

- [ ] **Step 2: Add i18n strings**

In `packages/i18n/src/locales/en/notes.json`, under `properties`:

```json
"showOnCalendar": "Show on calendar",
"showOnCalendarHint": "Adds an all-day chip on its date"
```

> Only `en` is required to pass `i18n:check`.

- [ ] **Step 3: Write the failing PropertyRow test**

In `PropertyRow.test.tsx`, render a `type: 'date'` property and a `type: 'text'` property; assert the calendar menu trigger is present only for date. Mock `@/hooks/use-calendar-properties` and the dropdown per renderer test conventions (Radix menus may need a mock to open in jsdom — follow the existing info-section test pattern):

```ts
it('shows a calendar toggle only for date properties', () => {
  // render PropertyRow with property.type === 'date' → trigger present
  // render with property.type === 'text' → trigger absent
})
```

Run: `pnpm --filter @memry/desktop test:renderer PropertyRow`
(If the alias fails, per the project note: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/note/info-section/PropertyRow.test.tsx`.)
Expected: FAIL.

- [ ] **Step 4: Add the inline menu to PropertyRow**

In `PropertyRow.tsx`:

- Import `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem` from `@/components/ui/dropdown-menu`, `Calendar` from `@/lib/icons`, and `useCalendarProperties`.
- `const { isEnabled, setEnabled } = useCalendarProperties()`.
- Render only for `property.type === 'date'`, in the trailing controls area (alongside the delete button, gated like it):

```tsx
{
  property.type === 'date' && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('properties.showOnCalendar')}
          className={cn(
            'ms-1 flex h-6 w-6 items-center justify-center rounded',
            'text-text-tertiary transition-all duration-150 hover:bg-surface hover:text-muted-foreground',
            isHovered || isEnabled(property.name) ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        >
          <Calendar className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={isEnabled(property.name)}
          onCheckedChange={(checked) => void setEnabled(property.name, checked === true)}
        >
          {t('properties.showOnCalendar')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

> Confirm `DropdownMenuCheckboxItem` is exported by `@/components/ui/dropdown-menu`; if not, use a `DropdownMenuItem` that toggles and renders a check icon. Keep the trigger visible (opacity-100) when enabled so it's discoverable to turn off.

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer PropertyRow`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-calendar-properties.ts apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.test.tsx packages/i18n/src/locales/en/notes.json
git commit -m "feat(notes): inline 'Show on calendar' toggle on date-property rows"
```

---

## Task 6: Note popover on chip click

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-note-popover.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-page.tsx`
- Modify: `packages/i18n/src/locales/en/calendar.json`

- [ ] **Step 1: Read the existing popover router + a sibling popover**

Read `calendar-page.tsx` (where it switches popover by `selectedItem.sourceType` — the `event` / `task` / `inbox_snooze` cases), `calendar-inbox-snooze-popover.tsx` (simplest sibling shell), and `calendar-task-popover.tsx` (for the renderer API it uses to open a note in a tab).

- [ ] **Step 2: Build the note popover**

`calendar-note-popover.tsx` — mirror `calendar-inbox-snooze-popover.tsx`'s shell (positioned popover, header, body, one action). Content per the approved mockup: note glyph + "Note", `"{descriptionPreview} · {formatted date}"` (descriptionPreview carries the property name), and an "Open note" action that opens `item.sourceId` via the same open-note API `calendar-task-popover.tsx` uses, then closes. Read-only — no edit/delete.

- [ ] **Step 3: Route note chips to it**

In `calendar-page.tsx`, add a branch: when `selectedItem.sourceType === 'note'`, render `<CalendarNotePopover ... />` with the same anchor/positioning props the other popovers receive.

- [ ] **Step 4: Add i18n strings**

In `calendar.json`:

```json
"notePopover": { "kind": "Note", "open": "Open note" }
```

- [ ] **Step 5: Manual verification**

Run `pnpm dev`: add a date property to a note, toggle "Show on calendar", open the calendar to that month, confirm the amber note chip appears on the right day, click it, confirm the popover shows `"Deadline · <date>"` and "Open note" opens the note. Verify the toggle persists after restart (and, if you have a second device synced, that it appears there too).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-note-popover.tsx apps/desktop/src/renderer/src/components/calendar/calendar-page.tsx packages/i18n/src/locales/en/calendar.json
git commit -m "feat(calendar): note chip popover with open-note action"
```

---

## Task 7: Full verification

- [ ] **Step 1: Lint + typecheck + tests + i18n + ipc**

Run, expect all green:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @memry/desktop test:main property-definitions
pnpm --filter @memry/desktop test:main projection
pnpm --filter @memry/desktop test:renderer PropertyRow
pnpm --filter @memry/desktop i18n:check
pnpm ipc:check
git diff --check
```

- [ ] **Step 2: Docs gate** (desktop changes)

Run: `pnpm docs:impact --base origin/main --strict`. If `missing-docs`, run `pnpm docs:ai-update --base origin/main` or update `apps/docs/src/**`, then re-run `--strict` and `pnpm docs:build`. If intentionally non-docs, push with `MEMRY_DOCS_IMPACT_SKIP=1` and note why.

- [ ] **Step 3: Final commit if docs changed**

```bash
git add apps/docs 2>/dev/null && git commit -m "docs: note date property on calendar" || true
```

---

## Self-Review notes

- **Spec coverage:** synced toggle (Task 1 + 5), projection/chip (Tasks 2-3), read-only click→open (Task 6), multiple date props per note → multiple chips (projectionId includes property name, Task 2).
- **Type consistency:** `setShowOnCalendar` / `listCalendarEnabledNames` identical across service (Task 1), handlers (Task 4), and the enabled-names getter (Task 3). `getCalendarRangeProjection(db, indexDb, input, enabledNames)` signature matches between projection (Task 2) and handler (Task 3). `'note'` added to both enums before any code references the literal (Task 3 precedes full typecheck).
- **No DB migration:** the flag lives in `properties.md`; the projection reads enabled names from `PropertyDefinitionsService`. No table/column/migration.
- **Assumptions to verify at task time (flagged inline):** `FileText` icon export; `DropdownMenuCheckboxItem` export; `registerCommand` arity; the calendar-page popover router shape; the note-open API in `calendar-task-popover.tsx`; the static-vs-dynamic import of `PropertyDefinitionsService` in `calendar-handlers.ts`.
- **Out of scope (fast-follows):** drag-to-reschedule (write the new date back to the property), settings-page mirror of the toggle.
