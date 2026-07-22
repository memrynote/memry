# Canvas "Add card" Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tasks and calendar events a UI path onto a spatial canvas by turning the in-canvas "New note" pill into an "Add card" picker over notes, tasks, and events.

**Architecture:** A pure candidate/geometry module (`canvas-add-card.ts`) does all merging, filtering, dedup, and scroll math with no React or Excalidraw imports. A hook (`use-canvas-add-search.ts`) owns the two async sources — `search.quick` for notes/tasks, one bounded `calendar.getRange` for events. A cmdk dialog renders three groups plus a pinned create-note row. `canvas-card-overlay.tsx` wires the three outcomes: create note, add card, reveal existing card.

**Tech Stack:** React 19, TypeScript, cmdk, Excalidraw 0.18.1, Vitest, Playwright, i18next.

## Global Constraints

- **Base branch: `origin/spatial-canvas-m7-rollout`** (commit `0f642d48c`). The docs corrected in Task 5 do not exist on `main`. Branch from m7-rollout, not main.
- **Renderer-only.** No contracts, IPC, DB schema, sync, or settings change. Do **not** run `pnpm ipc:generate` / `ipc:check` — nothing in `packages/contracts` changes.
- Feature rides behind the existing `spatialCanvas` flag (default-off). No released-user exposure.
- **Logging:** `createLogger('SpatialCanvas')` from `@/lib/logger`. Never `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **Tailwind logical properties only** in new code: `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`. No `ml-*`/`pl-*`/`left-*`.
- **i18n uses single-brace ICU**: `"Create note \"{query}\""`, never `{{query}}`. New keys go in `packages/i18n/src/locales/en/common.json`.
- Commit messages: no `Co-Authored-By` trailer.
- Verify with `pnpm --filter @memry/desktop test:renderer`, `pnpm typecheck`, `pnpm lint`.

---

### Task 1: Pure candidate + geometry module

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts`
- Test: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts`

**Interfaces:**

- Consumes: `CanvasEntityType` from `@memry/contracts/canvas-api`; `SearchResultItem` from `@memry/contracts/search-api`; `CalendarProjectionItem` from `@memry/contracts/calendar-api`.
- Produces: `AddCardCandidate`, `AddCardGroups`, `EVENT_RANGE_DAYS`, `candidateKey(entityType, entityId): string`, `candidatesFromSearch(results): AddCardCandidate[]`, `candidatesFromProjections(items, query): AddCardCandidate[]`, `onCanvasKeys(cards): Set<string>`, `markOnCanvas(candidates, keys): AddCardCandidate[]`, `groupCandidates(candidates): AddCardGroups`, `revealScroll(card, container, zoom): {scrollX, scrollY}`, `eventRange(now): {startAt, endAt}`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SearchResultItem } from '@memry/contracts/search-api'
import type { CalendarProjectionItem } from '@memry/contracts/calendar-api'
import {
  candidateKey,
  candidatesFromProjections,
  candidatesFromSearch,
  eventRange,
  groupCandidates,
  markOnCanvas,
  onCanvasKeys,
  revealScroll
} from './canvas-add-card'

function noteHit(id: string, title: string, fileType?: string): SearchResultItem {
  return {
    id,
    type: 'note',
    title,
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: '2026-07-01T00:00:00.000Z',
    metadata: {
      type: 'note',
      path: `notes/${title}.md`,
      tags: [],
      ...(fileType ? { fileType } : {})
    }
  } as SearchResultItem
}

function taskHit(id: string, title: string): SearchResultItem {
  return {
    id,
    type: 'task',
    title,
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: '2026-07-01T00:00:00.000Z',
    metadata: {
      type: 'task',
      projectId: 'p1',
      projectName: 'Inbox',
      projectColor: '#fff',
      statusId: null,
      statusName: null,
      dueDate: null,
      priority: 0,
      completedAt: null
    }
  } as SearchResultItem
}

function projection(
  sourceType: string,
  sourceId: string,
  title: string,
  startAt: string
): CalendarProjectionItem {
  return {
    projectionId: `${sourceId}-${startAt}`,
    sourceType,
    sourceId,
    title,
    descriptionPreview: null,
    startAt,
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: 'editable',
    source: {},
    binding: null
  } as unknown as CalendarProjectionItem
}

describe('candidatesFromSearch', () => {
  it('keeps markdown notes and tasks', () => {
    const out = candidatesFromSearch([noteHit('n1', 'Alpha'), taskHit('t1', 'Ship it')])
    expect(out).toEqual([
      {
        entityType: 'note',
        entityId: 'n1',
        title: 'Alpha',
        subtitle: 'notes/Alpha.md',
        onCanvas: false
      },
      { entityType: 'task', entityId: 't1', title: 'Ship it', subtitle: 'Inbox', onCanvas: false }
    ])
  })

  it('drops filed binaries masquerading as notes (#800)', () => {
    expect(candidatesFromSearch([noteHit('n2', 'Scan', 'pdf')])).toEqual([])
  })

  it('drops journal and inbox hits', () => {
    const journal = { ...noteHit('j1', 'Day'), type: 'journal' } as SearchResultItem
    ;(journal as { metadata: { type: string } }).metadata = { type: 'journal' }
    expect(candidatesFromSearch([journal])).toEqual([])
  })
})

describe('candidatesFromProjections', () => {
  it('keeps only Memry events, not tasks or external ones', () => {
    const out = candidatesFromProjections(
      [
        projection('event', 'e1', 'Standup', '2026-07-02T09:00:00.000Z'),
        projection('task', 't1', 'A task', '2026-07-02T09:00:00.000Z'),
        projection('external_event', 'g1', 'Google thing', '2026-07-02T09:00:00.000Z')
      ],
      ''
    )
    expect(out.map((c) => c.entityId)).toEqual(['e1'])
  })

  it('collapses a recurring event to its earliest occurrence', () => {
    const out = candidatesFromProjections(
      [
        projection('event', 'e1', 'Standup', '2026-07-09T09:00:00.000Z'),
        projection('event', 'e1', 'Standup', '2026-07-02T09:00:00.000Z')
      ],
      ''
    )
    expect(out).toHaveLength(1)
    expect(out[0].subtitle).toBe('2026-07-02T09:00:00.000Z')
  })

  it('filters by case-insensitive title substring and sorts by start', () => {
    const out = candidatesFromProjections(
      [
        projection('event', 'e2', 'Retro', '2026-07-10T09:00:00.000Z'),
        projection('event', 'e1', 'standup sync', '2026-07-02T09:00:00.000Z')
      ],
      'STAND'
    )
    expect(out.map((c) => c.entityId)).toEqual(['e1'])
  })
})

describe('markOnCanvas + groupCandidates', () => {
  it('flags entities already carded and groups by type', () => {
    const keys = onCanvasKeys([{ entityType: 'task', entityId: 't1' }])
    expect(keys.has(candidateKey('task', 't1'))).toBe(true)

    const marked = markOnCanvas(
      candidatesFromSearch([noteHit('n1', 'Alpha'), taskHit('t1', 'Ship it')]),
      keys
    )
    const groups = groupCandidates(marked)
    expect(groups.note[0].onCanvas).toBe(false)
    expect(groups.task[0].onCanvas).toBe(true)
    expect(groups.calendar_event).toEqual([])
  })
})

describe('revealScroll', () => {
  it('centers the viewport on the card', () => {
    // Card centered at (500, 400); an 800x600 viewport at zoom 1 centers it
    // when the scene point (500,400) maps to viewport (400,300).
    expect(
      revealScroll({ x: 400, y: 300, width: 200, height: 200 }, { width: 800, height: 600 }, 1)
    ).toEqual({ scrollX: -100, scrollY: -100 })
  })

  it('accounts for zoom', () => {
    expect(
      revealScroll({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 2)
    ).toEqual({ scrollX: 200, scrollY: 150 })
  })

  it('treats zoom 0 as 1 rather than dividing by zero', () => {
    const out = revealScroll({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 0)
    expect(Number.isFinite(out.scrollX)).toBe(true)
  })
})

describe('eventRange', () => {
  it('spans EVENT_RANGE_DAYS either side of now', () => {
    const now = Date.parse('2026-07-22T00:00:00.000Z')
    expect(eventRange(now)).toEqual({
      startAt: '2026-04-23T00:00:00.000Z',
      endAt: '2026-10-20T00:00:00.000Z'
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card`
Expected: FAIL — `Failed to resolve import "./canvas-add-card"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts`:

```ts
/**
 * Pure candidate + geometry helpers for the canvas "Add card" picker.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * merge/dedup/scroll logic unit-tests without either library.
 */

import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import type { CalendarProjectionItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'

/** How far either side of today the picker looks for events. */
export const EVENT_RANGE_DAYS = 90

export interface AddCardCandidate {
  entityType: CanvasEntityType
  entityId: string
  title: string
  /** Secondary line: note path, project name, or event start. */
  subtitle: string
  /** True when this entity already has a card on the open canvas. */
  onCanvas: boolean
}

export interface AddCardGroups {
  note: AddCardCandidate[]
  task: AddCardCandidate[]
  calendar_event: AddCardCandidate[]
}

/** Stable identity for a candidate, matching extractEntityRefs' key shape. */
export function candidateKey(entityType: CanvasEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
}

/**
 * Notes and tasks from a quick-search response. Journal and inbox hits are
 * dropped — neither is a CanvasEntityType.
 */
export function candidatesFromSearch(results: readonly SearchResultItem[]): AddCardCandidate[] {
  const out: AddCardCandidate[] = []
  for (const result of results) {
    if (result.metadata.type === 'note') {
      // A "note" hit can be a filed binary (pdf/image/audio/video — see #800).
      // Canvas note cards render markdown previews and open the markdown
      // editor, so a binary is not placeable.
      if ((result.metadata.fileType ?? 'markdown') !== 'markdown') {
        continue
      }
      out.push({
        entityType: 'note',
        entityId: result.id,
        title: result.title,
        subtitle: result.metadata.path,
        onCanvas: false
      })
    } else if (result.metadata.type === 'task') {
      out.push({
        entityType: 'task',
        entityId: result.id,
        title: result.title,
        subtitle: result.metadata.projectName,
        onCanvas: false
      })
    }
  }
  return out
}

/**
 * Memry events from a calendar range projection, filtered by title.
 * Tasks, reminders, notes and external Google events also project onto the
 * calendar, but only `sourceType: 'event'` is a `calendar_event` entity.
 */
export function candidatesFromProjections(
  items: readonly CalendarProjectionItem[],
  query: string
): AddCardCandidate[] {
  const needle = query.trim().toLowerCase()
  const earliest = new Map<string, CalendarProjectionItem>()
  for (const item of items) {
    if (item.sourceType !== 'event') {
      continue
    }
    if (needle && !item.title.toLowerCase().includes(needle)) {
      continue
    }
    // A recurring event yields one projection per occurrence; a card
    // references the event itself, so collapse to the earliest.
    const seen = earliest.get(item.sourceId)
    if (!seen || item.startAt < seen.startAt) {
      earliest.set(item.sourceId, item)
    }
  }
  return [...earliest.values()]
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((item) => ({
      entityType: 'calendar_event' as const,
      entityId: item.sourceId,
      title: item.title,
      subtitle: item.startAt,
      onCanvas: false
    }))
}

/** Candidate keys for every entity already carded on the open canvas. */
export function onCanvasKeys(
  cards: readonly { entityType: CanvasEntityType; entityId: string }[]
): Set<string> {
  return new Set(cards.map((card) => candidateKey(card.entityType, card.entityId)))
}

export function markOnCanvas(
  candidates: readonly AddCardCandidate[],
  keys: ReadonlySet<string>
): AddCardCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    onCanvas: keys.has(candidateKey(candidate.entityType, candidate.entityId))
  }))
}

export function groupCandidates(candidates: readonly AddCardCandidate[]): AddCardGroups {
  const groups: AddCardGroups = { note: [], task: [], calendar_event: [] }
  for (const candidate of candidates) {
    groups[candidate.entityType].push(candidate)
  }
  return groups
}

/**
 * Scroll offsets that center the viewport on a card. Inverts
 * viewportSceneRect: the viewport centre in scene units is
 * `-scrollX + width / (2 * zoom)`, which must equal the card centre.
 */
export function revealScroll(
  card: { x: number; y: number; width: number; height: number },
  container: { width: number; height: number },
  zoom: number
): { scrollX: number; scrollY: number } {
  const z = zoom || 1
  return {
    scrollX: container.width / (2 * z) - (card.x + card.width / 2),
    scrollY: container.height / (2 * z) - (card.y + card.height / 2)
  }
}

/** The bounded event window the picker queries. `now` is injected for tests. */
export function eventRange(now: number): { startAt: string; endAt: string } {
  const span = EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000
  return {
    startAt: new Date(now - span).toISOString(),
    endAt: new Date(now + span).toISOString()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts
git commit -m "feat(canvas): pure candidate and reveal-scroll helpers for the Add card picker"
```

---

### Task 2: Async source hook

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts`
- Test: `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.test.ts`

**Interfaces:**

- Consumes: `eventRange` from Task 1; `searchService` from `@/services/search-service`; `calendarService` from `@/services/calendar-service`.
- Produces: `useCanvasAddSearch(open: boolean, query: string): { results: SearchResultItem[]; projections: CalendarProjectionItem[]; loading: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quick: vi.fn(),
  getRange: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  searchService: { quick: (text: string) => mocks.quick(text) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { getRange: (input: unknown) => mocks.getRange(input) }
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { useCanvasAddSearch } from './use-canvas-add-search'

describe('useCanvasAddSearch', () => {
  beforeEach(() => {
    mocks.quick.mockReset().mockResolvedValue({ results: [{ id: 'n1' }], queryTimeMs: 1 })
    mocks.getRange.mockReset().mockResolvedValue({ items: [{ sourceId: 'e1' }] })
  })

  it('loads events once when the dialog opens, not per keystroke', async () => {
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: '' }
    })
    await waitFor(() => expect(mocks.getRange).toHaveBeenCalledTimes(1))
    rerender({ q: 'abc' })
    rerender({ q: 'abcd' })
    expect(mocks.getRange).toHaveBeenCalledTimes(1)
  })

  it('does not query anything while closed', async () => {
    renderHook(() => useCanvasAddSearch(false, 'abc'))
    await waitFor(() => expect(mocks.getRange).not.toHaveBeenCalled())
    expect(mocks.quick).not.toHaveBeenCalled()
  })

  it('skips search for an empty query but still returns events', async () => {
    const { result } = renderHook(() => useCanvasAddSearch(true, '   '))
    await waitFor(() => expect(result.current.projections).toHaveLength(1))
    expect(mocks.quick).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
  })

  it('debounces search and returns results', async () => {
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))
    await waitFor(() => expect(result.current.results).toEqual([{ id: 'n1' }]))
    expect(mocks.quick).toHaveBeenCalledWith('alpha')
    expect(result.current.loading).toBe(false)
  })

  it('falls back to empty results when search rejects', async () => {
    mocks.quick.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
  })

  it('falls back to empty events when the range query rejects', async () => {
    mocks.getRange.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCanvasAddSearch(true, ''))
    await waitFor(() => expect(mocks.getRange).toHaveBeenCalled())
    expect(result.current.projections).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-canvas-add-search`
Expected: FAIL — `Failed to resolve import "./use-canvas-add-search"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts`:

```ts
/**
 * The two async sources behind the canvas "Add card" picker.
 *
 * Notes and tasks come from quick-search. Events do NOT — the search index has
 * no calendar_event ContentType — so they come from one bounded
 * calendar.getRange call per dialog open, filtered client-side.
 */

import { useEffect, useState } from 'react'
import type { CalendarProjectionItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'
import { eventRange } from './canvas-add-card'

const log = createLogger('SpatialCanvas')

const SEARCH_DEBOUNCE_MS = 150

export interface CanvasAddSources {
  results: SearchResultItem[]
  projections: CalendarProjectionItem[]
  loading: boolean
}

export function useCanvasAddSearch(open: boolean, query: string): CanvasAddSources {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [projections, setProjections] = useState<CalendarProjectionItem[]>([])
  const [loading, setLoading] = useState(false)

  // Events load once per open: getRange is a bounded window, not a query, so
  // re-fetching per keystroke would decrypt the same set repeatedly.
  useEffect(() => {
    if (!open) {
      setProjections([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const range = eventRange(Date.now())
        const response = await calendarService.getRange({
          ...range,
          includeUnselectedSources: false
        })
        if (!cancelled) {
          setProjections(response.items)
        }
      } catch (err) {
        log.error('Canvas add-card: failed to load events', err)
        if (!cancelled) {
          setProjections([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || query.trim() === '') {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchService.quick(query)
          if (!cancelled) {
            setResults(response.results)
          }
        } catch (err) {
          log.error('Canvas add-card: search failed', err)
          if (!cancelled) {
            setResults([])
          }
        } finally {
          if (!cancelled) {
            setLoading(false)
          }
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  return { results, projections, loading }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-canvas-add-search`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.test.ts
git commit -m "feat(canvas): add-card source hook over quick-search and a bounded event range"
```

---

### Task 3: Picker dialog + i18n

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx`
- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.test.tsx`
- Modify: `packages/i18n/src/locales/en/common.json` (the `canvas.card` object)

**Interfaces:**

- Consumes: everything Task 1 produces; `useCanvasAddSearch` from Task 2.
- Produces: `CanvasAddCardDialog` with props `{ open: boolean; onOpenChange: (open: boolean) => void; onCanvasKeys: ReadonlySet<string>; onCreateNote: (title: string) => void; onPick: (entityType: CanvasEntityType, entityId: string) => void; onReveal: (entityType: CanvasEntityType, entityId: string) => void }`.

- [ ] **Step 1: Add the i18n keys**

In `packages/i18n/src/locales/en/common.json`, replace the `canvas.card` object's closing entries so the object reads:

```json
    "card": {
      "open": "Open in tab",
      "openToEdit": "Open in tab to edit",
      "deleted": "Item deleted",
      "loading": "Loading…",
      "untitled": "Untitled",
      "allDay": "All day",
      "newNote": "New note",
      "createNoteFailed": "Could not create note",
      "addCard": "Add card",
      "addPlaceholder": "Search notes, tasks and events…",
      "addCreateNote": "Create note \"{query}\"",
      "addCreateNoteEmpty": "Create new note",
      "addEmpty": "Nothing found",
      "addGroupNotes": "Notes",
      "addGroupTasks": "Tasks",
      "addGroupEvents": "Events",
      "addOnCanvas": "On canvas"
    }
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sources: {
    results: [] as unknown[],
    projections: [] as unknown[],
    loading: false
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.query
        ? `${key.split('.').at(-1)}:${String(vars.query)}`
        : (key.split('.').at(-1) ?? key)
  })
}))
vi.mock('./use-canvas-add-search', () => ({
  useCanvasAddSearch: () => mocks.sources
}))

import { CanvasAddCardDialog } from './canvas-add-card-dialog'

function noteResult(id: string, title: string) {
  return { id, type: 'note', title, metadata: { type: 'note', path: `n/${title}.md`, tags: [] } }
}
function taskResult(id: string, title: string) {
  return { id, type: 'task', title, metadata: { type: 'task', projectName: 'Inbox' } }
}
function eventProjection(sourceId: string, title: string) {
  return {
    projectionId: `${sourceId}-1`,
    sourceType: 'event',
    sourceId,
    title,
    startAt: '2026-07-22T09:00:00.000Z'
  }
}

function setup(overrides: Partial<Parameters<typeof CanvasAddCardDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onCanvasKeys: new Set<string>(),
    onCreateNote: vi.fn(),
    onPick: vi.fn(),
    onReveal: vi.fn(),
    ...overrides
  }
  render(<CanvasAddCardDialog {...props} />)
  return props
}

describe('CanvasAddCardDialog', () => {
  beforeEach(() => {
    mocks.sources = { results: [], projections: [], loading: false }
  })

  it('offers create-new-note when the query is empty', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('')
  })

  it('renders all three groups', async () => {
    mocks.sources = {
      results: [noteResult('n1', 'Alpha'), taskResult('t1', 'Ship it')],
      projections: [eventProjection('e1', 'Standup')],
      loading: false
    }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('Standup')).toBeInTheDocument()
  })

  it('picks a fresh entity', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onPick).toHaveBeenCalledWith('task', 't1')
    expect(props.onReveal).not.toHaveBeenCalled()
  })

  it('reveals instead of duplicating an entity already on the canvas', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup({ onCanvasKeys: new Set(['task:t1']) })
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.getByText('addOnCanvas')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onReveal).toHaveBeenCalledWith('task', 't1')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('keeps the create row visible while typing and carries the query', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'groceries' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('groceries')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card-dialog`
Expected: FAIL — `Failed to resolve import "./canvas-add-card-dialog"`.

- [ ] **Step 4: Write minimal implementation**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx`.

`Command.Dialog` comes from `cmdk` directly, not `@/components/ui/command` — the
shadcn `CommandDialog` wrapper spreads its props onto `Dialog` and cannot forward
`shouldFilter`. `components/search/command-palette.tsx` is the in-repo precedent.

```tsx
/**
 * The canvas "Add card" picker: search notes, tasks and events, or create a
 * new note. Filtering is ours (shouldFilter={false}) because results arrive
 * pre-filtered from two different sources.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { Plus } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import {
  candidateKey,
  candidatesFromProjections,
  candidatesFromSearch,
  groupCandidates,
  markOnCanvas,
  type AddCardCandidate
} from './canvas-add-card'
import { useCanvasAddSearch } from './use-canvas-add-search'

/** cmdk value for the pinned create row; never collides with a candidateKey. */
const CREATE_VALUE = '__create_note__'

export interface CanvasAddCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `entityType:entityId` keys already carded on this canvas. */
  onCanvasKeys: ReadonlySet<string>
  onCreateNote: (title: string) => void
  onPick: (entityType: CanvasEntityType, entityId: string) => void
  onReveal: (entityType: CanvasEntityType, entityId: string) => void
}

export function CanvasAddCardDialog({
  open,
  onOpenChange,
  onCanvasKeys,
  onCreateNote,
  onPick,
  onReveal
}: CanvasAddCardDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [query, setQuery] = useState('')
  const [value, setValue] = useState(CREATE_VALUE)
  const { results, projections } = useCanvasAddSearch(open, query)

  // Reset between openings so a stale query never greets the next open.
  useEffect(() => {
    if (!open) {
      setQuery('')
    }
  }, [open])

  const groups = useMemo(() => {
    const merged = [
      ...candidatesFromSearch(results),
      ...candidatesFromProjections(projections, query)
    ]
    return groupCandidates(markOnCanvas(merged, onCanvasKeys))
  }, [results, projections, query, onCanvasKeys])

  // When there are matches the first one takes the highlight, so Enter picks an
  // existing item; the create row is one arrow-up away.
  useEffect(() => {
    const first = groups.note[0] ?? groups.task[0] ?? groups.calendar_event[0]
    setValue(first ? candidateKey(first.entityType, first.entityId) : CREATE_VALUE)
  }, [groups])

  const select = (candidate: AddCardCandidate): void => {
    if (candidate.onCanvas) {
      onReveal(candidate.entityType, candidate.entityId)
    } else {
      onPick(candidate.entityType, candidate.entityId)
    }
    onOpenChange(false)
  }

  const renderGroup = (heading: string, items: AddCardCandidate[]): React.JSX.Element | null => {
    if (items.length === 0) {
      return null
    }
    return (
      <Command.Group heading={heading}>
        {items.map((candidate) => {
          const key = candidateKey(candidate.entityType, candidate.entityId)
          return (
            <Command.Item
              key={key}
              value={key}
              data-testid={`canvas-add-item-${key}`}
              onSelect={() => select(candidate)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{candidate.title}</span>
                <span className="truncate text-xs text-text-tertiary">{candidate.subtitle}</span>
              </span>
              {candidate.onCanvas ? (
                <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  {t('canvas.card.addOnCanvas')}
                </span>
              ) : null}
            </Command.Item>
          )
        })}
      </Command.Group>
    )
  }

  const hasResults =
    groups.note.length > 0 || groups.task.length > 0 || groups.calendar_event.length > 0

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      label={t('canvas.card.addCard')}
      className="fixed start-1/2 top-24 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        data-testid="canvas-add-input"
        placeholder={t('canvas.card.addPlaceholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Item
          value={CREATE_VALUE}
          data-testid="canvas-add-create-note"
          onSelect={() => {
            onCreateNote(query.trim())
            onOpenChange(false)
          }}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          {query.trim()
            ? t('canvas.card.addCreateNote', { query: query.trim() })
            : t('canvas.card.addCreateNoteEmpty')}
        </Command.Item>
        {!hasResults && query.trim() ? (
          <Command.Empty className="px-2 py-6 text-center text-sm text-text-tertiary">
            {t('canvas.card.addEmpty')}
          </Command.Empty>
        ) : null}
        {renderGroup(t('canvas.card.addGroupNotes'), groups.note)}
        {renderGroup(t('canvas.card.addGroupTasks'), groups.task)}
        {renderGroup(t('canvas.card.addGroupEvents'), groups.calendar_event)}
      </Command.List>
    </Command.Dialog>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card-dialog`
Expected: PASS, 5 tests.

If cmdk items do not respond to `fireEvent.click` under jsdom (the known picker
gotcha), switch the assertions to `fireEvent.keyDown(input, { key: 'Enter' })`
after setting `value` — do **not** weaken the test to a render-only assertion.

- [ ] **Step 6: Verify i18n**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (English is the gated locale; other locales report warnings only).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.test.tsx packages/i18n/src/locales/en/common.json
git commit -m "feat(canvas): Add card picker dialog over notes, tasks and events"
```

---

### Task 4: Wire the picker into the overlay

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.test.tsx:200`
- Modify: `apps/desktop/tests/e2e/canvas-cards.e2e.ts:155-168`

**Interfaces:**

- Consumes: `CanvasAddCardDialog` (Task 3); `onCanvasKeys`, `revealScroll` (Task 1).
- Produces: no new exports. The pill becomes `data-testid="canvas-add-card"`.

- [ ] **Step 1: Update the overlay component test**

In `canvas-card-overlay.test.tsx`, add the dialog stub beside the existing mocks
(after the `./embedded-note-editor` mock, around line 63):

```tsx
// Stub the picker; its own test covers filtering and selection.
vi.mock('./canvas-add-card-dialog', () => ({
  CanvasAddCardDialog: ({
    open,
    onCreateNote
  }: {
    open: boolean
    onCreateNote: (title: string) => void
  }) =>
    open ? (
      <button data-testid="stub-create-note" onClick={() => onCreateNote('')}>
        create
      </button>
    ) : null
}))
```

Then replace the existing create-note assertion at line 200:

```tsx
fireEvent.click(screen.getByTestId('canvas-add-card'))
fireEvent.click(screen.getByTestId('stub-create-note'))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-card-overlay`
Expected: FAIL — `Unable to find an element by: [data-testid="canvas-add-card"]`.

- [ ] **Step 3: Implement the wiring**

In `canvas-card-overlay.tsx`:

(a) Add imports beside the existing `./canvas-cards` import block:

```ts
import { CanvasAddCardDialog } from './canvas-add-card-dialog'
import { onCanvasKeys, revealScroll } from './canvas-add-card'
```

(b) Add dialog state next to the other `useState` calls:

```ts
const [addOpen, setAddOpen] = useState(false)
const [addKeys, setAddKeys] = useState<ReadonlySet<string>>(() => new Set<string>())
```

(c) Replace `handleCreateNote` (currently at line 344) so it accepts a title:

```ts
const handleCreateNote = useCallback(
  async (title: string) => {
    try {
      const result = await notesService.create({
        title: title || 'Untitled Note',
        content: ''
      })
      if (!result.success || !result.note) {
        throw new Error(result.error ?? 'note create failed')
      }
      const { appState } = readScene()
      const rect = viewportSceneRect(appState, {
        width: clipRef.current?.clientWidth ?? 0,
        height: clipRef.current?.clientHeight ?? 0
      })
      createCardElement(
        'note',
        result.note.id,
        (rect.minX + rect.maxX) / 2,
        (rect.minY + rect.maxY) / 2
      )
    } catch (err) {
      log.error('Failed to create canvas note', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'common')('canvas.card.createNoteFailed')
        )
      )
    }
  },
  [readScene, createCardElement]
)
```

(d) Add the pick and reveal handlers directly after it:

```ts
const handlePick = useCallback(
  (entityType: CanvasCardRef['entityType'], entityId: string) => {
    const { appState } = readScene()
    const rect = viewportSceneRect(appState, {
      width: clipRef.current?.clientWidth ?? 0,
      height: clipRef.current?.clientHeight ?? 0
    })
    createCardElement(
      entityType,
      entityId,
      (rect.minX + rect.maxX) / 2,
      (rect.minY + rect.maxY) / 2
    )
  },
  [readScene, createCardElement]
)

// Picking an entity that already has a card centers that card instead of
// adding a second one, so entity refs stay 1:1 and arrows never fragment.
const handleReveal = useCallback(
  (entityType: CanvasCardRef['entityType'], entityId: string) => {
    const { cards, appState } = readScene()
    const card = cards.find((c) => c.entityType === entityType && c.entityId === entityId)
    if (!card) {
      return
    }
    const { scrollX, scrollY } = revealScroll(
      card,
      {
        width: clipRef.current?.clientWidth ?? 0,
        height: clipRef.current?.clientHeight ?? 0
      },
      appState.zoom.value
    )
    excalidrawAPI.updateScene({
      appState: { scrollX, scrollY, selectedElementIds: { [card.elementId]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    })
    recompute()
  },
  [readScene, excalidrawAPI, recompute]
)

// Snapshot the carded entities when the picker opens. A useMemo keyed on
// `addOpen` would read the scene on every render and trip exhaustive-deps
// (addOpen is not referenced in the computation).
const openAddDialog = useCallback(() => {
  setAddKeys(
    onCanvasKeys(getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[]))
  )
  setAddOpen(true)
}, [excalidrawAPI])
```

(e) Replace the pill button and add the dialog in the returned JSX:

```tsx
      <button
        type="button"
        onClick={openAddDialog}
        data-testid="canvas-add-card"
        // Horizontally centered (symmetric in RTL) via inline left/translate.
        style={{ left: '50%', transform: 'translateX(-50%)' }}
        className="pointer-events-auto absolute bottom-4 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t('canvas.card.addCard')}
      </button>
      <CanvasAddCardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCanvasKeys={addKeys}
        onCreateNote={(title) => void handleCreateNote(title)}
        onPick={handlePick}
        onReveal={handleReveal}
      />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-card-overlay`
Expected: PASS.

- [ ] **Step 5: Update the e2e**

In `apps/desktop/tests/e2e/canvas-cards.e2e.ts`, add this helper beside `seedNote` (line 48):

```ts
async function seedTask(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (t) => {
    const projects = await window.api.tasks.listProjects()
    const projectId = projects?.projects?.[0]?.id
    if (!projectId) return ''
    const res = await window.api.tasks.create({ projectId, title: t })
    return res?.task?.id ?? res?.id ?? ''
  }, title)
  if (!id) throw new Error(`seedTask failed for ${title}`)
  return id
}
```

Replace the `capture-first` test (lines 155-168) with these two:

```ts
test('capture-first: the Add card picker creates a note card on the canvas', async ({ page }) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  const canvasId = await createCanvasFromSidebar(page)

  await page.getByTestId('canvas-add-card').click()
  await page.getByTestId('canvas-add-create-note').click()

  await expect(page.locator('[data-canvas-card-id]')).toHaveCount(1, { timeout: 20000 })
  await expect
    .poll(async () => cardRects((await sceneOf(page, canvasId)).parsed).length, {
      timeout: 15000
    })
    .toBe(1)
})

test('the Add card picker places an existing task card on the canvas', async ({ page }) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  const canvasId = await createCanvasFromSidebar(page)

  const title = `Canvas Task ${Date.now()}`
  await seedTask(page, title)

  await page.getByTestId('canvas-add-card').click()
  // The task must reach the search index first, so retype until it shows up
  // rather than asserting once against a cold index.
  await expect
    .poll(
      async () => {
        await page.getByTestId('canvas-add-input').fill('')
        await page.getByTestId('canvas-add-input').fill(title)
        return page.locator('[data-testid^="canvas-add-item-task:"]').count()
      },
      { timeout: 30000 }
    )
    .toBeGreaterThan(0)

  await page.locator('[data-testid^="canvas-add-item-task:"]').first().click()

  await expect(page.locator('[data-canvas-card-id]')).toHaveCount(1, { timeout: 20000 })
  await expect
    .poll(
      async () => {
        const rects = cardRects((await sceneOf(page, canvasId)).parsed)
        return rects.filter((r) => r.customData?.entityType === 'task').length
      },
      { timeout: 15000 }
    )
    .toBe(1)
})
```

- [ ] **Step 6: Run the e2e**

Run: `pnpm --filter @memry/desktop test:e2e -- canvas-cards`
Expected: PASS. If the build is stale, rebuild first — e2e runs the built app, not sources.

- [ ] **Step 7: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @memry/desktop test:renderer
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.test.tsx apps/desktop/tests/e2e/canvas-cards.e2e.ts
git commit -m "feat(canvas): place task and event cards from the Add card picker"
```

---

### Task 5: Correct the user documentation

**Files:**

- Modify: `apps/docs/src/user-guide/canvas/cards-and-links.md` (~lines 8-15)
- Modify: `apps/docs/src/user-guide/canvas/sync-and-limits.md` (~lines 40-42)

These files exist only on `origin/spatial-canvas-m7-rollout`. If they are absent, the branch base is wrong — stop and rebase before continuing.

- [ ] **Step 1: Rewrite the cards-and-links "how to add" section**

Replace the bullet list and the paragraph that begins "Task and calendar-event cards are fully supported once they're on a canvas" with:

```markdown
- **Drag a note** from the sidebar onto the canvas.
- **Click "Add card"** at the bottom of the canvas to search your notes, tasks
  and events, or to create a new note without leaving the board.

Task and calendar-event cards are added through **Add card**. Dragging works for
notes from the sidebar; the Tasks and Calendar pages have no drag-in, because
they open as tabs in place of the canvas rather than beside it.

If you pick something that is already on the board, Memry scrolls to the card
you already have instead of adding a duplicate.
```

- [ ] **Step 2: Rewrite the sync-and-limits limitation**

Replace the bullet reading "Adding a task or calendar-event card requires the note-drag or New note … drag-in from the Tasks or Calendar pages yet." with:

```markdown
- The **Add card** picker searches events within 90 days either side of today.
  Events outside that window are not listed; open the event from the Calendar
  page and add it from there instead.
- There is no drag-in from the Tasks or Calendar pages — use **Add card**.
```

- [ ] **Step 3: Verify the docs gate**

```bash
pnpm docs:impact --base origin/spatial-canvas-m7-rollout --strict
pnpm docs:build
```

Expected: both green. `docs:impact` needs a commit to compare against, so commit first if it reports nothing to analyze.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/user-guide/canvas/cards-and-links.md apps/docs/src/user-guide/canvas/sync-and-limits.md
git commit -m "docs(canvas): document the Add card picker and the event range limit"
```

---

## Verification

Full gate before opening the PR:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm docs:build
```

PR is a **draft** by default. Base it on `spatial-canvas-m7-rollout`, not `main`.
