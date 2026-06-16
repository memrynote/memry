# TickTick CSV Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a TickTick backup `.csv` into Memry as projects, tasks (with subtasks), kanban statuses, tags, reminders, and repeat rules, via Settings → Import.

**Architecture:** A pure transform package `@memry/ticktick-import` (CSV → `ImportPlan`, no fs/electron/db, fully unit-tested — mirrors the sibling `@memry/notion-import`) plus thin desktop glue: a main apply service that writes the plan through the existing async tasks **domain layer** (`createDesktopTasksDomain`) + reminders lib, one IPC channel, a preload wrapper, and a Settings → Import section. Writes are **sequential, not transactional** (the domain layer is async; better-sqlite3 transactions are sync-only) — per-row failures are skipped + warned; a hard failure returns a partial summary.

**Tech Stack:** TypeScript, Vitest (node), Drizzle/better-sqlite3, Electron IPC (`@memry/contracts`), React 19 renderer.

**Spec:** `docs/superpowers/specs/2026-06-15-ticktick-importer-design.md`

**Verified integration facts (do not re-derive):**

- Domain factory: `createDesktopTasksDomain(db, createTasksPublisher(), generateId)` (`apps/desktop/src/main/tasks/domain.ts`) returns BOTH queries + commands. Commands are **async**, return `{ success, task/project/... }`.
  - `createProject({ name, description?, color?, icon?, statuses? })` — creates custom statuses when `statuses.length >= 2`, else default `To Do/In Progress/Done`. `StatusDefinitionInput = { id?, name, color, type: 'todo'|'in_progress'|'done', order }`.
  - `createTask({ projectId, title, description?, priority?, statusId?, parentId?, dueDate?, dueTime?, startDate?, repeatConfig?, repeatFrom?, tags?, position? })` — sets tags internally; always inserts `completedAt: null, archivedAt: null`.
  - `completeTask({ id, completedAt? })`, `archiveTask(id)` — follow-up calls for completed / won't-do.
  - Queries: `listProjects(): ProjectWithStats[]` (has `isInbox`), `getProject(id): ProjectWithStatuses` (has `statuses`), `listStatuses(id): Status[]`.
- Inbox project lookup (raw): `import { getInboxProject } from '@main/database/queries/projects'` → `getInboxProject(db): Project | undefined`. Main service code may import `@main/database/queries/*` (the domain does).
- Reminders (raw, main): `import * as remindersService from '../lib/reminders'` → `remindersService.createReminder({ targetType: 'task', targetId, remindAt, note? })` (sync; same call the reminder IPC handler uses).
- `Task['priority'] = 0|1|2|3|4`; `Task['repeatFrom'] = 'due' | 'completion' | null` (an enum, NOT a date); `RepeatConfig` is exported from `@memry/domain-tasks` (`packages/domain-tasks/src/types.ts`).
- IPC helpers (`apps/desktop/src/main/ipc/validate.ts`): `createHandler(fn)` (no input), `createValidatedHandler(schema, fn)`, `withErrorHandler(fn, fallback)`. Channels: `XChannels = { invoke: {...}, events: {...} } as const` in `packages/contracts/src/ipc-channels.ts`. Handlers registered in `apps/desktop/src/main/ipc/index.ts` (`registerAllHandlers` + `unregisterAllHandlers`).
- File dialog pattern: `apps/desktop/src/main/ipc/notes-handlers.ts` (`dialog.showOpenDialog`).
- Settings nav: `apps/desktop/src/renderer/src/pages/settings.tsx` (nav item + conditional render keyed on `useSettingsModal().activeSection`); section union lives in `apps/desktop/src/renderer/src/contexts/settings-modal-context` (confirm exact file when editing). Logging `createLogger('Scope')`; user errors `extractErrorMessage`.
- After editing contracts/preload/handlers: `pnpm ipc:generate` then `pnpm ipc:check`.
- Reference CSV: `/Users/h4yfans/Downloads/TickTick-backup-2026-06-15.csv` (manual QA only — NOT committed).
- Test a single pure package: `pnpm --filter @memry/ticktick-import test`. Desktop main suite: `pnpm --filter @memry/desktop test:main`.

---

## Phase 1 — Pure transform package `@memry/ticktick-import`

### Task 1: Scaffold the package

**Files:**

- Create: `packages/ticktick-import/package.json`
- Create: `packages/ticktick-import/tsconfig.json`
- Create: `packages/ticktick-import/vitest.config.ts`
- Create: `packages/ticktick-import/src/index.ts`

- [ ] **Step 1: Create `package.json`** (mirrors `@memry/notion-import`, no runtime deps — drop `gray-matter`)

```json
{
  "name": "@memry/ticktick-import",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*",
    "vitest": "4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "@memry/typescript-config/node.json",
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts']
  }
})
```

- [ ] **Step 4: Create `src/index.ts`** (empty barrel for now)

```ts
export {}
```

- [ ] **Step 5: Install + verify the workspace picks up the package**

Run: `pnpm install`
Then: `pnpm --filter @memry/ticktick-import test`
Expected: exits 0 ("No test files found" is fine — `--passWithNoTests`).

- [ ] **Step 6: Commit**

```bash
git add packages/ticktick-import pnpm-lock.yaml
git commit -m "chore(ticktick-import): scaffold pure transform package"
```

---

### Task 2: CSV tokenizer + TickTick row parser

**Files:**

- Create: `packages/ticktick-import/src/types.ts`
- Create: `packages/ticktick-import/src/parse-csv.ts`
- Test: `packages/ticktick-import/test/parse-csv.test.ts`

- [ ] **Step 1: Add `TickTickRow` to `src/types.ts`**

```ts
export interface TickTickRow {
  folderName: string
  listName: string
  title: string
  kind: string
  tags: string[]
  content: string
  isCheckList: boolean
  startDate: string
  dueDate: string
  reminder: string
  repeat: string
  priority: number
  status: number
  createdTime: string
  completedTime: string
  order: string
  timezone: string
  isAllDay: boolean
  isFloating: boolean
  columnName: string
  columnOrder: string
  viewMode: string
  taskId: string
  parentId: string
  projectKind: string
}
```

- [ ] **Step 2: Write the failing test `test/parse-csv.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { tokenizeCsv, parseTickTickCsv } from '../src/parse-csv'

const PREAMBLE =
  '﻿"Date: 2026-06-15+0000"\n"Version: 7.2"\n"Status: \n0 Normal\n1 Completed\n2 Archived"\n'
const HEADER =
  '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","projectKind"\n'

describe('tokenizeCsv', () => {
  it('strips BOM and parses quoted fields with embedded commas + newlines + escaped quotes', () => {
    const rows = tokenizeCsv('﻿"a","b,c","line1\nline2","say ""hi"""\n')
    expect(rows).toEqual([['a', 'b,c', 'line1\nline2', 'say "hi"']])
  })
})

describe('parseTickTickCsv', () => {
  it('skips preamble, finds the Folder Name header, and maps one data row', () => {
    const dataRow =
      '"","Inbox","Buy milk","TEXT","home, errands","note body","N","","2020-05-07T08:00:00+0000","-PT1440M","FREQ=YEARLY;INTERVAL=1","5","2","2020-04-21T16:04:14+0000","2020-04-22T10:00:00+0000","-1099511627776","Europe/Istanbul","false","false","","","list","1","","TASK"\n'
    const rows = parseTickTickCsv(PREAMBLE + HEADER + dataRow)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.listName).toBe('Inbox')
    expect(r.title).toBe('Buy milk')
    expect(r.tags).toEqual(['home', 'errands'])
    expect(r.priority).toBe(5)
    expect(r.status).toBe(2)
    expect(r.dueDate).toBe('2020-05-07T08:00:00+0000')
    expect(r.reminder).toBe('-PT1440M')
    expect(r.repeat).toBe('FREQ=YEARLY;INTERVAL=1')
    expect(r.timezone).toBe('Europe/Istanbul')
    expect(r.taskId).toBe('1')
    expect(r.parentId).toBe('')
  })

  it('throws when the header row is absent', () => {
    expect(() => parseTickTickCsv('"just","data"\n')).toThrow(/header/i)
  })
})
```

- [ ] **Step 2b: Run it to confirm failure**

Run: `pnpm --filter @memry/ticktick-import test`
Expected: FAIL ("Cannot find module '../src/parse-csv'").

- [ ] **Step 3: Implement `src/parse-csv.ts`**

```ts
import type { TickTickRow } from './types'

/** RFC-4180 tokenizer; strips a leading BOM. Handles quoted commas/newlines + "" escapes. */
export function tokenizeCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      record.push(field)
      field = ''
      continue
    }
    if (c === '\r') continue
    if (c === '\n') {
      record.push(field)
      records.push(record)
      field = ''
      record = []
      continue
    }
    field += c
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

const HEADER_FIRST_CELL = 'Folder Name'

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

function bool(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true'
}

function int(raw: string): number {
  const n = parseInt(raw.trim(), 10)
  return Number.isNaN(n) ? 0 : n
}

export function parseTickTickCsv(input: string): TickTickRow[] {
  const records = tokenizeCsv(input)
  const headerIdx = records.findIndex((r) => (r[0] ?? '').trim() === HEADER_FIRST_CELL)
  if (headerIdx === -1) throw new Error('TickTick CSV header row ("Folder Name") not found')
  const headers = records[headerIdx].map((h) => h.trim())
  const col = (cells: string[], name: string): string => {
    const idx = headers.indexOf(name)
    return idx === -1 ? '' : (cells[idx] ?? '')
  }
  return records
    .slice(headerIdx + 1)
    .filter((cells) => cells.some((c) => c.length > 0))
    .map((cells) => ({
      folderName: col(cells, 'Folder Name'),
      listName: col(cells, 'List Name'),
      title: col(cells, 'Title'),
      kind: col(cells, 'Kind'),
      tags: splitTags(col(cells, 'Tags')),
      content: col(cells, 'Content'),
      isCheckList: bool(col(cells, 'Is Check list')),
      startDate: col(cells, 'Start Date'),
      dueDate: col(cells, 'Due Date'),
      reminder: col(cells, 'Reminder'),
      repeat: col(cells, 'Repeat'),
      priority: int(col(cells, 'Priority')),
      status: int(col(cells, 'Status')),
      createdTime: col(cells, 'Created Time'),
      completedTime: col(cells, 'Completed Time'),
      order: col(cells, 'Order'),
      timezone: col(cells, 'Timezone'),
      isAllDay: bool(col(cells, 'Is All Day')),
      isFloating: bool(col(cells, 'Is Floating')),
      columnName: col(cells, 'Column Name'),
      columnOrder: col(cells, 'Column Order'),
      viewMode: col(cells, 'View Mode'),
      taskId: col(cells, 'taskId'),
      parentId: col(cells, 'parentId'),
      projectKind: col(cells, 'projectKind')
    }))
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @memry/ticktick-import test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ticktick-import/src/types.ts packages/ticktick-import/src/parse-csv.ts packages/ticktick-import/test/parse-csv.test.ts
git commit -m "feat(ticktick-import): BOM-safe CSV parser with header detection"
```

---

### Task 3: Priority mapping

**Files:**

- Create: `packages/ticktick-import/src/priority.ts`
- Test: `packages/ticktick-import/test/priority.test.ts`

- [ ] **Step 1: Failing test `test/priority.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { mapPriority } from '../src/priority'

describe('mapPriority', () => {
  it('maps TickTick 0/1/3/5 to Memry 0/1/2/3', () => {
    expect(mapPriority(0)).toEqual({ priority: 0 })
    expect(mapPriority(1)).toEqual({ priority: 1 })
    expect(mapPriority(3)).toEqual({ priority: 2 })
    expect(mapPriority(5)).toEqual({ priority: 3 })
  })
  it('falls back to 0 with a warning for unknown values', () => {
    const r = mapPriority(9)
    expect(r.priority).toBe(0)
    expect(r.warning).toMatch(/priority/i)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`pnpm --filter @memry/ticktick-import test`).

- [ ] **Step 3: Implement `src/priority.ts`**

```ts
export type MemryPriority = 0 | 1 | 2 | 3 | 4

const TABLE: Record<number, MemryPriority> = { 0: 0, 1: 1, 3: 2, 5: 3 }

export function mapPriority(ticktick: number): { priority: MemryPriority; warning?: string } {
  const mapped = TABLE[ticktick]
  if (mapped === undefined) {
    return { priority: 0, warning: `Unknown TickTick priority ${ticktick} → none` }
  }
  return { priority: mapped }
}
```

- [ ] **Step 4: Run → PASS. Step 5: Commit**

```bash
git add packages/ticktick-import/src/priority.ts packages/ticktick-import/test/priority.test.ts
git commit -m "feat(ticktick-import): priority mapping"
```

---

### Task 4: ISO-8601 duration parsing (reminders)

**Files:**

- Create: `packages/ticktick-import/src/duration.ts`
- Test: `packages/ticktick-import/test/duration.test.ts`

- [ ] **Step 1: Failing test `test/duration.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { parseIsoDurationMs } from '../src/duration'

describe('parseIsoDurationMs', () => {
  it('parses zero, minutes, hours, days, and negatives', () => {
    expect(parseIsoDurationMs('PT0S')).toBe(0)
    expect(parseIsoDurationMs('-PT1440M')).toBe(-1440 * 60 * 1000)
    expect(parseIsoDurationMs('-P0DT9H0M0S')).toBe(-9 * 60 * 60 * 1000)
    expect(parseIsoDurationMs('P1D')).toBe(24 * 60 * 60 * 1000)
  })
  it('returns null for junk', () => {
    expect(parseIsoDurationMs('')).toBeNull()
    expect(parseIsoDurationMs('soon')).toBeNull()
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/duration.ts`**

```ts
const PATTERN = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/** Parse an ISO-8601 duration (TickTick reminder offset) to signed milliseconds. */
export function parseIsoDurationMs(token: string): number | null {
  const t = token.trim()
  if (!t) return null
  const m = PATTERN.exec(t)
  if (!m) return null
  const [, sign, w, d, h, min, s] = m
  if (!w && !d && !h && !min && !s) return t === 'PT0S' || t === 'P0D' ? 0 : 0
  const ms =
    (Number(w ?? 0) * 7 * 24 * 60 * 60 +
      Number(d ?? 0) * 24 * 60 * 60 +
      Number(h ?? 0) * 60 * 60 +
      Number(min ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  return sign === '-' ? -ms : ms
}
```

- [ ] **Step 4: Run → PASS. Step 5: Commit**

```bash
git add packages/ticktick-import/src/duration.ts packages/ticktick-import/test/duration.test.ts
git commit -m "feat(ticktick-import): ISO-8601 duration parsing for reminders"
```

---

### Task 5: Timezone-aware date/time splitting

**Files:**

- Create: `packages/ticktick-import/src/dates.ts`
- Test: `packages/ticktick-import/test/dates.test.ts`

- [ ] **Step 1: Failing test `test/dates.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { splitDateTime } from '../src/dates'

describe('splitDateTime', () => {
  it('returns local date + time in the given timezone', () => {
    // 08:00 UTC in Istanbul (+03:00) → 11:00 local
    expect(splitDateTime('2020-05-07T08:00:00+0000', 'Europe/Istanbul', false)).toEqual({
      date: '2020-05-07',
      time: '11:00'
    })
  })
  it('drops the time for all-day', () => {
    expect(splitDateTime('2020-05-07T08:00:00+0000', 'Europe/Istanbul', true)).toEqual({
      date: '2020-05-07',
      time: null
    })
  })
  it('returns nulls for empty/invalid input', () => {
    expect(splitDateTime('', 'UTC', false)).toEqual({ date: null, time: null })
    expect(splitDateTime('nope', 'UTC', false)).toEqual({ date: null, time: null })
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/dates.ts`**

```ts
export interface DatePieces {
  date: string | null
  time: string | null
}

/** Convert a tz-aware ISO instant to { date 'YYYY-MM-DD', time 'HH:mm' } in `timezone`. */
export function splitDateTime(iso: string, timezone: string, allDay: boolean): DatePieces {
  if (!iso.trim()) return { date: null, time: null }
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return { date: null, time: null }
  const tz = timezone.trim() || 'UTC'
  let parts: Record<string, string>
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]))
  } catch {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]))
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, time: allDay ? null : `${parts.hour}:${parts.minute}` }
}
```

- [ ] **Step 4: Run → PASS. Step 5: Commit**

```bash
git add packages/ticktick-import/src/dates.ts packages/ticktick-import/test/dates.test.ts
git commit -m "feat(ticktick-import): timezone-aware date/time splitting"
```

---

### Task 6: RRULE → RepeatConfig

**Files:**

- Create: `packages/ticktick-import/src/rrule.ts`
- Test: `packages/ticktick-import/test/rrule.test.ts`

- [ ] **Step 1: Failing test `test/rrule.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { rruleToRepeatConfig } from '../src/rrule'

const NOW = '2026-06-15T00:00:00.000Z'

describe('rruleToRepeatConfig', () => {
  it('maps yearly', () => {
    expect(rruleToRepeatConfig('FREQ=YEARLY;INTERVAL=1', NOW)).toMatchObject({
      frequency: 'yearly',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: NOW
    })
  })
  it('maps monthly day-of-month', () => {
    expect(rruleToRepeatConfig('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15', NOW)).toMatchObject({
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 15
    })
  })
  it('maps weekly BYDAY to daysOfWeek', () => {
    expect(rruleToRepeatConfig('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', NOW)).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3, 5]
    })
  })
  it('maps COUNT and UNTIL endings', () => {
    expect(rruleToRepeatConfig('FREQ=DAILY;COUNT=10', NOW)).toMatchObject({
      endType: 'count',
      endCount: 10
    })
    expect(rruleToRepeatConfig('FREQ=DAILY;UNTIL=20261231T000000Z', NOW)).toMatchObject({
      endType: 'date',
      endDate: '2026-12-31'
    })
  })
  it('returns null for empty or unsupported frequency', () => {
    expect(rruleToRepeatConfig('', NOW)).toBeNull()
    expect(rruleToRepeatConfig('FREQ=HOURLY', NOW)).toBeNull()
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/rrule.ts`**

```ts
import type { RepeatConfig } from './types'

const FREQ: Record<string, RepeatConfig['frequency']> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly'
}
const DAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function untilToDate(until: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(until.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** Convert a TickTick RRULE string to Memry RepeatConfig, or null if unsupported. */
export function rruleToRepeatConfig(rrule: string, now: string): RepeatConfig | null {
  const body = rrule.trim().replace(/^RRULE:/i, '')
  if (!body) return null
  const parts: Record<string, string> = {}
  for (const kv of body.split(';')) {
    const [k, v] = kv.split('=')
    if (k) parts[k.toUpperCase()] = v ?? ''
  }
  const frequency = FREQ[(parts.FREQ ?? '').toUpperCase()]
  if (!frequency) return null

  const cfg: RepeatConfig = {
    frequency,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1),
    endType: 'never',
    completedCount: 0,
    createdAt: now
  }

  if (parts.BYDAY && frequency === 'weekly') {
    cfg.daysOfWeek = parts.BYDAY.split(',')
      .map((token) => DAY[token.replace(/^[+-]?\d+/, '').toUpperCase()])
      .filter((n): n is number => n !== undefined)
  }
  if (parts.BYMONTHDAY && frequency === 'monthly') {
    cfg.monthlyType = 'dayOfMonth'
    cfg.dayOfMonth = parseInt(parts.BYMONTHDAY, 10)
  } else if (parts.BYDAY && parts.BYSETPOS && frequency === 'monthly') {
    cfg.monthlyType = 'weekPattern'
    cfg.weekOfMonth = parseInt(parts.BYSETPOS, 10)
    cfg.dayOfWeekForMonth = DAY[parts.BYDAY.replace(/^[+-]?\d+/, '').toUpperCase()]
  }

  if (parts.COUNT) {
    cfg.endType = 'count'
    cfg.endCount = parseInt(parts.COUNT, 10)
  } else if (parts.UNTIL) {
    const endDate = untilToDate(parts.UNTIL)
    if (endDate) {
      cfg.endType = 'date'
      cfg.endDate = endDate
    }
  }
  return cfg
}
```

> Note: `RepeatConfig` is added to `src/types.ts` in Task 7 (it must match `@memry/domain-tasks`). The import compiles once Task 7 lands; run this task's test after Task 7 if running strictly in order, OR add the `RepeatConfig` interface in this step. To keep tasks independent, add it now in `src/types.ts`:

```ts
export interface RepeatConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  weekOfMonth?: number
  dayOfWeekForMonth?: number
  endType: 'never' | 'date' | 'count'
  endDate?: string | null
  endCount?: number
  completedCount: number
  createdAt: string
}
```

- [ ] **Step 4: Run → PASS. Step 5: Commit**

```bash
git add packages/ticktick-import/src/rrule.ts packages/ticktick-import/src/types.ts packages/ticktick-import/test/rrule.test.ts
git commit -m "feat(ticktick-import): RRULE to RepeatConfig conversion"
```

---

### Task 7: Plan types

**Files:**

- Modify: `packages/ticktick-import/src/types.ts`

- [ ] **Step 1: Append the plan types** (after `TickTickRow` + `RepeatConfig`)

```ts
export type MemryPriority = 0 | 1 | 2 | 3 | 4
export type StatusType = 'todo' | 'in_progress' | 'done'

export interface StatusPlan {
  tempId: string
  name: string
  color: string
  type: StatusType
  order: number
  isDone: boolean
}

export interface ProjectPlan {
  tempId: string
  name: string
  useExistingInbox: boolean
  statuses: StatusPlan[]
}

export interface ReminderPlan {
  remindAt: string
}

export interface TaskPlan {
  tempId: string
  projectTempId: string
  parentTempId: string | null
  statusTempId: string | null
  title: string
  description: string | null
  priority: MemryPriority
  position: number
  startDate: string | null
  dueDate: string | null
  dueTime: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string | null
  tags: string[]
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  reminders: ReminderPlan[]
}

export interface ImportWarning {
  message: string
  row?: number
}

export interface ImportStats {
  rows: number
  projects: number
  tasks: number
  subtasks: number
  reminders: number
}

export interface ImportPlan {
  projects: ProjectPlan[]
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: ImportStats
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @memry/ticktick-import typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ticktick-import/src/types.ts
git commit -m "feat(ticktick-import): import plan types"
```

---

### Task 8: `mapRows` — CSV rows → ImportPlan

**Files:**

- Create: `packages/ticktick-import/src/map-rows.ts`
- Test: `packages/ticktick-import/test/map-rows.test.ts`

- [ ] **Step 1: Failing test `test/map-rows.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { mapRows } from '../src/map-rows'
import type { TickTickRow } from '../src/types'

const NOW = '2026-06-15T00:00:00.000Z'

function row(overrides: Partial<TickTickRow> = {}): TickTickRow {
  return {
    folderName: '',
    listName: 'Inbox',
    title: 'Task',
    kind: 'TEXT',
    tags: [],
    content: '',
    isCheckList: false,
    startDate: '',
    dueDate: '',
    reminder: '',
    repeat: '',
    priority: 0,
    status: 0,
    createdTime: '',
    completedTime: '',
    order: '0',
    timezone: 'UTC',
    isAllDay: false,
    isFloating: false,
    columnName: '',
    columnOrder: '',
    viewMode: 'list',
    taskId: '',
    parentId: '',
    projectKind: 'TASK',
    ...overrides
  }
}

describe('mapRows', () => {
  it('binds the Inbox list to the existing inbox project', () => {
    const plan = mapRows([row({ listName: 'Inbox', title: 'A' })], { now: NOW })
    expect(plan.projects).toHaveLength(1)
    expect(plan.projects[0].useExistingInbox).toBe(true)
    expect(plan.stats.tasks).toBe(1)
  })

  it('creates a new project with default statuses for a list-view list', () => {
    const plan = mapRows([row({ listName: 'Books', title: 'B' })], { now: NOW })
    const proj = plan.projects.find((p) => p.name === 'Books')!
    expect(proj.useExistingInbox).toBe(false)
    expect(proj.statuses.map((s) => s.type)).toEqual(['todo', 'in_progress', 'done'])
  })

  it('builds kanban statuses from Column Name ordered by Column Order', () => {
    const rows = [
      row({
        listName: 'Vids',
        title: 'X',
        columnName: 'To Do',
        columnOrder: '-100',
        viewMode: 'kanban'
      }),
      row({
        listName: 'Vids',
        title: 'Y',
        columnName: 'Watching',
        columnOrder: '50',
        viewMode: 'kanban'
      })
    ]
    const proj = mapRows(rows, { now: NOW }).projects.find((p) => p.name === 'Vids')!
    expect(proj.statuses.map((s) => s.name)).toEqual(['To Do', 'Watching'])
    expect(proj.statuses[0].isDone).toBe(false)
  })

  it('resolves parent/child via taskId/parentId', () => {
    const rows = [
      row({ listName: 'Inbox', title: 'Parent', taskId: '1' }),
      row({ listName: 'Inbox', title: 'Child', taskId: '2', parentId: '1' })
    ]
    const plan = mapRows(rows, { now: NOW })
    const parent = plan.tasks.find((t) => t.title === 'Parent')!
    const child = plan.tasks.find((t) => t.title === 'Child')!
    expect(child.parentTempId).toBe(parent.tempId)
    expect(plan.stats.subtasks).toBe(1)
  })

  it('warns and de-parents a child whose parent is missing', () => {
    const plan = mapRows([row({ title: 'Orphan', taskId: '2', parentId: '99' })], { now: NOW })
    expect(plan.tasks[0].parentTempId).toBeNull()
    expect(plan.warnings.some((w) => /parent/i.test(w.message))).toBe(true)
  })

  it('maps completion, priority, tags, dates, repeat, and reminders', () => {
    const plan = mapRows(
      [
        row({
          title: 'Done thing',
          priority: 5,
          status: 2,
          completedTime: '2020-04-22T10:00:00+0000',
          tags: ['x'],
          dueDate: '2020-05-07T08:00:00+0000',
          timezone: 'Europe/Istanbul',
          reminder: '-PT1440M',
          repeat: 'FREQ=YEARLY;INTERVAL=1'
        })
      ],
      { now: NOW }
    )
    const t = plan.tasks[0]
    expect(t.priority).toBe(3)
    expect(t.completedAt).toBe('2020-04-22T10:00:00+0000')
    expect(t.tags).toEqual(['x'])
    expect(t.dueDate).toBe('2020-05-07')
    expect(t.dueTime).toBe('11:00')
    expect(t.repeatConfig?.frequency).toBe('yearly')
    expect(t.repeatFrom).toBe('due')
    expect(t.reminders).toHaveLength(1)
    expect(plan.stats.reminders).toBe(1)
  })

  it("marks won't-do (status -1) as archived", () => {
    const plan = mapRows([row({ title: 'Nope', status: -1 })], { now: NOW })
    expect(plan.tasks[0].archivedAt).toBe(NOW)
  })

  it('warns once when a Folder Name is present', () => {
    const plan = mapRows([row({ folderName: 'Work', title: 'Z' })], { now: NOW })
    expect(plan.warnings.some((w) => /folder/i.test(w.message))).toBe(true)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/map-rows.ts`**

```ts
import type {
  ImportPlan,
  ImportWarning,
  ProjectPlan,
  StatusPlan,
  StatusType,
  TaskPlan,
  TickTickRow
} from './types'
import { mapPriority } from './priority'
import { parseIsoDurationMs } from './duration'
import { splitDateTime } from './dates'
import { rruleToRepeatConfig } from './rrule'

const INBOX_NAME = 'Inbox'
const DEFAULT_STATUSES: Array<{ name: string; color: string; type: StatusType; isDone: boolean }> =
  [
    { name: 'To Do', color: '#6b7280', type: 'todo', isDone: false },
    { name: 'In Progress', color: '#F59E0B', type: 'in_progress', isDone: false },
    { name: 'Done', color: '#10b981', type: 'done', isDone: true }
  ]

function bigintCompare(a: string, b: string): number {
  const toBig = (s: string): bigint => {
    try {
      return BigInt(s.trim() || '0')
    } catch {
      return 0n
    }
  }
  const x = toBig(a)
  const y = toBig(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function mapRows(rows: TickTickRow[], opts: { now: string }): ImportPlan {
  const { now } = opts
  const warnings: ImportWarning[] = []

  // 1. Group rows by list (blank → Inbox).
  const listNames: string[] = []
  const rowsByList = new Map<string, TickTickRow[]>()
  let sawFolder = false
  rows.forEach((r) => {
    if (r.folderName.trim()) sawFolder = true
    const list = r.listName.trim() || INBOX_NAME
    if (!rowsByList.has(list)) {
      rowsByList.set(list, [])
      listNames.push(list)
    }
    rowsByList.get(list)!.push(r)
  })
  if (sawFolder) {
    warnings.push({ message: 'TickTick folders have no Memry equivalent and were dropped' })
  }

  // 2. Build projects + statuses; remember the temp status id for each (list, columnName).
  let seq = 0
  const newId = (prefix: string): string => `${prefix}-${seq++}`
  const projects: ProjectPlan[] = []
  const projectTempIdByList = new Map<string, string>()
  const statusTempIdByListColumn = new Map<string, string>() // key `${list} ${columnName}`
  const defaultStatusByList = new Map<string, { todo: string; done: string }>()

  for (const list of listNames) {
    const listRows = rowsByList.get(list)!
    const isInbox = list === INBOX_NAME
    const projectTempId = newId('project')
    projectTempIdByList.set(list, projectTempId)

    const columns = [
      ...new Set(listRows.map((r) => r.columnName.trim()).filter((c) => c.length > 0))
    ]
    const statuses: StatusPlan[] = []

    if (columns.length >= 2) {
      const order = new Map<string, string>()
      listRows.forEach((r) => {
        const c = r.columnName.trim()
        if (c && !order.has(c)) order.set(c, r.columnOrder)
      })
      columns
        .sort((a, b) => bigintCompare(order.get(a) ?? '0', order.get(b) ?? '0'))
        .forEach((name, idx) => {
          const tempId = newId('status')
          const isDone = /done|complete/i.test(name)
          statuses.push({
            tempId,
            name,
            color: isDone ? '#10b981' : '#6b7280',
            type: isDone ? 'done' : idx === 0 ? 'todo' : 'in_progress',
            order: idx,
            isDone
          })
          statusTempIdByListColumn.set(`${list} ${name}`, tempId)
        })
    } else {
      DEFAULT_STATUSES.forEach((s, idx) => {
        const tempId = newId('status')
        statuses.push({
          tempId,
          name: s.name,
          color: s.color,
          type: s.type,
          order: idx,
          isDone: s.isDone
        })
      })
      defaultStatusByList.set(list, { todo: statuses[0].tempId, done: statuses[2].tempId })
    }

    projects.push({ tempId: projectTempId, name: list, useExistingInbox: isInbox, statuses })
  }

  // 3. taskId → tempId map (synthetic id for blank taskIds).
  const tempIdByTaskId = new Map<string, string>()
  const rowTempIds = rows.map((r) => {
    const tempId = newId('task')
    if (r.taskId.trim()) tempIdByTaskId.set(r.taskId.trim(), tempId)
    return tempId
  })

  // 4. Build task plans.
  const tasks: TaskPlan[] = []
  let subtasks = 0
  let reminderCount = 0

  rows.forEach((r, index) => {
    const list = r.listName.trim() || INBOX_NAME
    const projectTempId = projectTempIdByList.get(list)!

    let parentTempId: string | null = null
    if (r.parentId.trim()) {
      const resolved = tempIdByTaskId.get(r.parentId.trim())
      if (resolved) {
        parentTempId = resolved
        subtasks++
      } else {
        warnings.push({
          row: index,
          message: `Subtask "${r.title}" parent not found; imported top-level`
        })
      }
    }

    // status assignment
    let statusTempId: string | null = null
    const col = r.columnName.trim()
    const completed = r.status === 2 || r.completedTime.trim().length > 0
    if (col && statusTempIdByListColumn.has(`${list} ${col}`)) {
      statusTempId = statusTempIdByListColumn.get(`${list} ${col}`)!
    } else {
      const def = defaultStatusByList.get(list)
      if (def) statusTempId = completed ? def.done : def.todo
    }

    const { priority, warning: prioWarn } = mapPriority(r.priority)
    if (prioWarn) warnings.push({ row: index, message: prioWarn })

    const due = splitDateTime(r.dueDate, r.timezone, r.isAllDay)
    const start = splitDateTime(r.startDate, r.timezone, true)

    const completedAt = completed ? r.completedTime.trim() || now : null
    const archivedAt = r.status === -1 ? now : null

    const repeatConfig = r.repeat.trim() ? rruleToRepeatConfig(r.repeat, now) : null
    if (r.repeat.trim() && !repeatConfig) {
      warnings.push({ row: index, message: `Unsupported repeat rule "${r.repeat}" skipped` })
    }

    // reminders: anchor at due, else start instant
    const anchorIso = r.dueDate.trim() || r.startDate.trim()
    const reminders: TaskPlan['reminders'] = []
    if (r.reminder.trim()) {
      for (const token of r.reminder
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)) {
        const ms = parseIsoDurationMs(token)
        if (ms === null || !anchorIso) {
          warnings.push({ row: index, message: `Reminder "${token}" skipped (no date anchor)` })
          continue
        }
        const remindAt = new Date(new Date(anchorIso).getTime() + ms).toISOString()
        reminders.push({ remindAt })
        reminderCount++
      }
    }

    tasks.push({
      tempId: rowTempIds[index],
      projectTempId,
      parentTempId,
      statusTempId,
      title: r.title || 'Untitled',
      description: r.content.trim() ? r.content : null,
      priority,
      position: 0, // assigned below
      startDate: start.date,
      dueDate: due.date,
      dueTime: due.time,
      completedAt,
      archivedAt,
      createdAt: r.createdTime.trim() || null,
      tags: r.tags,
      repeatConfig,
      repeatFrom: repeatConfig ? 'due' : null,
      reminders
    })
  })

  // 5. Position: order by the TickTick `Order` column within each (project, status).
  const groups = new Map<string, TaskPlan[]>()
  tasks.forEach((t, i) => {
    const key = `${t.projectTempId} ${t.statusTempId ?? ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
    // stash original Order for sorting
    ;(t as TaskPlan & { _order?: string })._order = rows[i].order
  })
  for (const group of groups.values()) {
    group
      .sort((a, b) =>
        bigintCompare(
          (a as TaskPlan & { _order?: string })._order ?? '0',
          (b as TaskPlan & { _order?: string })._order ?? '0'
        )
      )
      .forEach((t, idx) => {
        t.position = idx
      })
  }
  tasks.forEach((t) => {
    delete (t as TaskPlan & { _order?: string })._order
  })

  return {
    projects,
    tasks,
    warnings,
    stats: {
      rows: rows.length,
      projects: projects.length,
      tasks: tasks.length,
      subtasks,
      reminders: reminderCount
    }
  }
}
```

- [ ] **Step 4: Run → PASS** (all `map-rows` tests).

- [ ] **Step 5: Update `src/index.ts` barrel**

```ts
export * from './types'
export * from './parse-csv'
export * from './priority'
export * from './duration'
export * from './dates'
export * from './rrule'
export * from './map-rows'
```

- [ ] **Step 6: Full package check + commit**

Run: `pnpm --filter @memry/ticktick-import test && pnpm --filter @memry/ticktick-import typecheck`
Expected: PASS.

```bash
git add packages/ticktick-import/src/map-rows.ts packages/ticktick-import/src/index.ts packages/ticktick-import/test/map-rows.test.ts
git commit -m "feat(ticktick-import): map CSV rows to an import plan"
```

---

## Phase 2 — Contracts + desktop main wiring

### Task 9: IPC contract + channel

**Files:**

- Create: `packages/contracts/src/ticktick-import-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (add channel group + export)

- [ ] **Step 1: Create `ticktick-import-api.ts`**

```ts
export interface TickTickImportWarning {
  message: string
  row?: number
}

export interface TickTickImportStats {
  rows: number
  projects: number
  tasks: number
  subtasks: number
  reminders: number
}

export interface TickTickImportSummary {
  canceled: boolean
  stats: TickTickImportStats
  warnings: TickTickImportWarning[]
}
```

- [ ] **Step 2: Add the channel to `ipc-channels.ts`** (new section near the other groups)

```ts
// ============================================================================
// TickTick Import Channels
// ============================================================================

export const TickTickImportChannels = {
  invoke: {
    /** Open a file picker and import a TickTick CSV backup */
    RUN: 'ticktick-import:run'
  }
} as const
```

- [ ] **Step 3: Verify contracts build**

Run: `pnpm --filter @memry/contracts typecheck` (or `pnpm check:contracts`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ticktick-import-api.ts packages/contracts/src/ipc-channels.ts
git commit -m "feat(contracts): TickTick import IPC channel + summary types"
```

---

### Task 10: Main apply service

**Files:**

- Create: `apps/desktop/src/main/import/ticktick/ticktick-import-service.ts`
- Test: `apps/desktop/src/main/import/ticktick/ticktick-import-service.test.ts`

- [ ] **Step 1: Implement `ticktick-import-service.ts`**

```ts
import type { DataDb } from '../../database'
import { getInboxProject } from '@main/database/queries/projects'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { generateId } from '../../lib/id'
import * as remindersService from '../../lib/reminders'
import { createLogger } from '../../lib/logger'
import { parseTickTickCsv, mapRows, type ImportPlan } from '@memry/ticktick-import'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'

const log = createLogger('TickTickImport')

type TasksDomain = ReturnType<typeof createDesktopTasksDomain>

/** Apply a parsed plan into the data DB via the async task domain layer. */
export async function applyPlan(
  db: DataDb,
  plan: ImportPlan,
  domain: TasksDomain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
): Promise<TickTickImportSummary> {
  const projectIdByTemp = new Map<string, string>()
  const statusIdByTemp = new Map<string, string>()
  const warnings = [...plan.warnings]

  // Projects + statuses
  for (const p of plan.projects) {
    if (p.useExistingInbox) {
      const inbox = getInboxProject(db)
      if (!inbox) {
        warnings.push({ message: 'No inbox project found; Inbox tasks skipped' })
        continue
      }
      projectIdByTemp.set(p.tempId, inbox.id)
      const existing = domain.listStatuses(inbox.id)
      const todo = existing.find((s) => s.isDefault) ?? existing[0]
      const done = existing.find((s) => s.isDone) ?? todo
      // Map the inbox plan's two synthetic statuses (todo/done) onto the real ones.
      const planTodo = p.statuses.find((s) => s.type !== 'done')
      const planDone = p.statuses.find((s) => s.isDone)
      if (planTodo && todo) statusIdByTemp.set(planTodo.tempId, todo.id)
      if (planDone && done) statusIdByTemp.set(planDone.tempId, done.id)
      continue
    }

    const result = await domain.createProject({
      name: p.name,
      statuses: p.statuses.map((s) => ({
        name: s.name,
        color: s.color,
        type: s.type,
        order: s.order
      }))
    })
    if (!result.success || !result.project) {
      warnings.push({ message: `Failed to create project "${p.name}"` })
      continue
    }
    projectIdByTemp.set(p.tempId, result.project.id)
    const realStatuses = domain.listStatuses(result.project.id)
    // statuses are created in the same order we sent them
    p.statuses.forEach((planStatus, idx) => {
      const real = realStatuses[idx]
      if (real) statusIdByTemp.set(planStatus.tempId, real.id)
    })
  }

  // Tasks (parents before children so parentId resolves)
  const tempIdToRealId = new Map<string, string>()
  const ordered = [...plan.tasks].sort((a, b) => {
    const aChild = a.parentTempId ? 1 : 0
    const bChild = b.parentTempId ? 1 : 0
    return aChild - bChild
  })

  for (const t of ordered) {
    const projectId = projectIdByTemp.get(t.projectTempId)
    if (!projectId) {
      warnings.push({ message: `Task "${t.title}" skipped (no project)` })
      continue
    }
    try {
      const created = await domain.createTask({
        projectId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        statusId: t.statusTempId ? (statusIdByTemp.get(t.statusTempId) ?? null) : null,
        parentId: t.parentTempId ? (tempIdToRealId.get(t.parentTempId) ?? null) : null,
        position: t.position,
        startDate: t.startDate,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        repeatConfig: t.repeatConfig,
        repeatFrom: t.repeatFrom,
        tags: t.tags
      })
      if (!created.success || !created.task) {
        warnings.push({ message: `Task "${t.title}" failed to import` })
        continue
      }
      const realId = created.task.id
      tempIdToRealId.set(t.tempId, realId)

      if (t.completedAt) await domain.completeTask({ id: realId, completedAt: t.completedAt })
      if (t.archivedAt) await domain.archiveTask(realId)

      for (const reminder of t.reminders) {
        remindersService.createReminder({
          targetType: 'task',
          targetId: realId,
          remindAt: reminder.remindAt
        })
      }
    } catch (err) {
      log.error('Task import failed', err)
      warnings.push({ message: `Task "${t.title}" failed: ${(err as Error).message}` })
    }
  }

  return { canceled: false, stats: plan.stats, warnings }
}

/** Read a CSV file's contents, parse + map + apply. */
export async function importTickTickCsv(
  db: DataDb,
  csvText: string
): Promise<TickTickImportSummary> {
  const rows = parseTickTickCsv(csvText)
  const plan = mapRows(rows, { now: new Date().toISOString() })
  log.info(`Importing ${plan.stats.tasks} tasks across ${plan.stats.projects} projects`)
  return applyPlan(db, plan)
}
```

> Confirm `createTasksPublisher` lives at `apps/desktop/src/main/tasks/publisher.ts` and `generateId` at `apps/desktop/src/main/lib/id.ts` (both imported by `tasks-handlers.ts`). Confirm `remindersService.createReminder` signature in `apps/desktop/src/main/lib/reminders.ts` accepts `{ targetType, targetId, remindAt }`; adjust the call to match (it is the same object the reminder IPC handler passes).

- [ ] **Step 2: Write the integration test `ticktick-import-service.test.ts`**

Use the same in-memory `DataDb` setup the existing task/main tests use. Find a sibling main test that builds a `DataDb` (e.g. search `apps/desktop/src/main` for `createDataDb`/`drizzle(`/`:memory:`), and reuse that helper). Then:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { importTickTickCsv } from './ticktick-import-service'
// import { makeTestDataDb } from '<the existing main test db helper>'

const CSV = [
  '﻿"Date: 2026-06-15+0000"',
  '"Version: 7.2"',
  '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","projectKind"',
  '"","Books","Read Dune","TEXT","sci-fi","","N","","","","","3","0","2020-01-01T00:00:00+0000","","10","UTC","false","false","","","list","1","","TASK"',
  '"","Books","Chapter 1","TEXT","","","N","","","","","0","2","2020-01-01T00:00:00+0000","2020-02-01T00:00:00+0000","20","UTC","false","false","","","list","2","1","TASK"'
].join('\n')

describe('importTickTickCsv', () => {
  let db: ReturnType<typeof makeTestDataDb>
  beforeEach(() => {
    db = makeTestDataDb()
  })

  it('creates a project with a subtask and a completed task', async () => {
    const summary = await importTickTickCsv(db, CSV)
    expect(summary.stats.projects).toBe(1)
    expect(summary.stats.tasks).toBe(2)
    expect(summary.stats.subtasks).toBe(1)
    // assert via the domain queries that the project + tasks exist (use createDesktopTasksDomain to read)
  })
})
```

> If no reusable in-memory `DataDb` helper exists in the main suite, create one in the test using the same Drizzle + better-sqlite3 + migrations setup the app uses (search for where `initDatabase` runs migrations). Keep DB assertions through `createDesktopTasksDomain(db, ...).listTasks(...)`.

- [ ] **Step 3: Run the main suite for this file**

Run: `pnpm --filter @memry/desktop test:main -- ticktick-import-service`
Expected: PASS. If `better-sqlite3` fails to load → `pnpm --filter @memry/desktop rebuild:node`, then re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/import/ticktick/
git commit -m "feat(ticktick-import): main apply service over the tasks domain"
```

---

### Task 11: IPC handler + registration

**Files:**

- Create: `apps/desktop/src/main/ipc/ticktick-import-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts` (register + unregister)

- [ ] **Step 1: Implement `ticktick-import-handlers.ts`**

```ts
import { ipcMain, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { TickTickImportChannels } from '@memry/contracts/ipc-channels'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'
import { requireDatabase } from '../database'
import { createHandler } from './validate'
import { importTickTickCsv } from '../import/ticktick/ticktick-import-service'
import { createLogger } from '../lib/logger'

const log = createLogger('IPC:TickTickImport')

const EMPTY: TickTickImportSummary = {
  canceled: true,
  stats: { rows: 0, projects: 0, tasks: 0, subtasks: 0, reminders: 0 },
  warnings: []
}

export function registerTickTickImportHandlers(): void {
  ipcMain.handle(
    TickTickImportChannels.invoke.RUN,
    createHandler(async (): Promise<TickTickImportSummary> => {
      const db = requireDatabase()
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return EMPTY
      const csvText = await readFile(result.filePaths[0], 'utf8')
      try {
        return await importTickTickCsv(db, csvText)
      } catch (err) {
        log.error('Import failed', err)
        throw err instanceof Error ? err : new Error('TickTick import failed')
      }
    })
  )
}

export function unregisterTickTickImportHandlers(): void {
  ipcMain.removeHandler(TickTickImportChannels.invoke.RUN)
}
```

- [ ] **Step 2: Register in `apps/desktop/src/main/ipc/index.ts`**

Add import near the other handler imports:

```ts
import {
  registerTickTickImportHandlers,
  unregisterTickTickImportHandlers
} from './ticktick-import-handlers'
```

Add inside `registerAllHandlers()` (with the other `register*` calls):

```ts
// Register TickTick import handler
registerTickTickImportHandlers()
```

Add inside `unregisterAllHandlers()`:

```ts
unregisterTickTickImportHandlers()
```

- [ ] **Step 3: Regenerate + validate IPC types**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: PASS (the new `ticktick-import:run` channel appears in the generated invoke map with return type `TickTickImportSummary`). Fix typing if `ipc:check` flags it.

- [ ] **Step 4: Typecheck node side + commit**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

```bash
git add apps/desktop/src/main/ipc/ticktick-import-handlers.ts apps/desktop/src/main/ipc/index.ts apps/desktop/src/preload apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(ticktick-import): IPC handler with CSV file picker"
```

---

### Task 12: Preload wrapper

**Files:**

- Create: `apps/desktop/src/preload/api/ticktick-import.ts`
- Modify: `apps/desktop/src/preload/api/index.ts` (export it)

- [ ] **Step 1: Implement `preload/api/ticktick-import.ts`** (mirror `preload/api/reminders.ts`)

```ts
import { TickTickImportChannels } from '@memry/contracts/ipc-channels'
import { invoke } from '../lib/ipc'

export const tickTickImportApi = {
  run: () => invoke(TickTickImportChannels.invoke.RUN)
}
```

- [ ] **Step 2: Export from `preload/api/index.ts`**

Add: `export { tickTickImportApi } from './ticktick-import'` and include `tickTickImportApi` wherever the preload composes the `window.api` object (follow how `remindersApi` is wired — search `remindersApi` in `apps/desktop/src/preload`).

- [ ] **Step 3: Regenerate + check, typecheck**

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS. `window.api.tickTickImport.run()` is now typed to return `Promise<TickTickImportSummary>`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload
git commit -m "feat(ticktick-import): preload api wrapper"
```

---

## Phase 3 — Renderer: Settings → Import

### Task 13: Add the `import` settings section

**Files:**

- Modify: settings section union (search `apps/desktop/src/renderer/src/contexts/settings-modal-context*` for the `activeSection` / `SettingsSection` type — add `'import'`)
- Create: `apps/desktop/src/renderer/src/pages/settings/import-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings.tsx` (nav item + render)
- Modify: `packages/i18n/.../en/settings.json` (or the desktop settings i18n source — find where `page.nav.items.tags` is defined)

- [ ] **Step 1: Add `'import'` to the section union** in the settings-modal context type (wherever `'vault' | 'tags' | 'properties' | ...` is declared).

- [ ] **Step 2: Create `import-section.tsx`**

```tsx
import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { taskKeys } from '@/features/tasks/use-task-queries'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'

const log = createLogger('Settings:Import')

export function ImportSettings() {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<TickTickImportSummary | null>(null)

  const runImport = async () => {
    setBusy(true)
    setSummary(null)
    try {
      const result = await window.api.tickTickImport.run()
      if (result.canceled) return
      setSummary(result)
      await queryClient.invalidateQueries({ queryKey: taskKeys.all })
      toast.success(t('import.ticktick.success', { count: result.stats.tasks }))
    } catch (err) {
      log.error('TickTick import failed', err)
      toast.error(extractErrorMessage(err, t('import.ticktick.failed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">{t('import.ticktick.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('import.ticktick.description')}</p>
      </div>
      <div>
        <Button onClick={runImport} disabled={busy}>
          {busy ? t('import.ticktick.importing') : t('import.ticktick.button')}
        </Button>
      </div>
      {summary && (
        <div className="text-xs">
          <p>
            {t('import.ticktick.result', {
              projects: summary.stats.projects,
              tasks: summary.stats.tasks,
              subtasks: summary.stats.subtasks,
              reminders: summary.stats.reminders
            })}
          </p>
          {summary.warnings.length > 0 && (
            <details className="mt-2">
              <summary>{t('import.ticktick.warnings', { count: summary.warnings.length })}</summary>
              <ul className="mt-1 list-disc ps-4">
                {summary.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
```

> Verify exact import paths for `Button`, `useT`, `taskKeys`, and the `window.api.tickTickImport` accessor name (match what Task 12 exposed). Use logical Tailwind classes (`ps-*`, not `pl-*`).

- [ ] **Step 3: Wire into `settings.tsx`**

Add the icon import (e.g. `Download`) to the `@/lib/icons` import block. Add a nav item under the DATA group (after `properties`):

```tsx
<SettingsNavItem
  icon={<Download className="w-3.5 h-3.5" />}
  label={t('page.nav.items.import')}
  isActive={activeSection === 'import'}
  onClick={() => setActiveSection('import')}
/>
```

Add the conditional render (with the others):

```tsx
{
  activeSection === 'import' && <ImportSettings />
}
```

And the component import at the top:

```tsx
import { ImportSettings } from './settings/import-section'
```

- [ ] **Step 4: Add i18n keys** to the English settings namespace (the file that defines `page.nav.items.tags`):

```json
"page": { "nav": { "items": { "import": "Import" } } },
"import": {
  "ticktick": {
    "title": "Import from TickTick",
    "description": "Import a TickTick CSV backup as projects, tasks, tags, reminders and repeats.",
    "button": "Import from TickTick (CSV)",
    "importing": "Importing…",
    "success": "Imported {{count}} tasks",
    "failed": "TickTick import failed",
    "result": "Imported {{projects}} projects, {{tasks}} tasks ({{subtasks}} subtasks), {{reminders}} reminders.",
    "warnings": "{{count}} warnings",
    "result_skipped": ""
  }
}
```

> Merge these keys into the existing JSON structure (do not overwrite the file). Only the English (`en`) settings namespace is gated by `i18n:check`; other locales are non-fatal.

- [ ] **Step 5: Verify renderer typecheck + i18n + lint**

Run: `pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop i18n:check && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/src/renderer/src/pages/settings.tsx packages/i18n
git commit -m "feat(ticktick-import): Settings Import section UI"
```

---

## Phase 4 — Final verification

### Task 14: Full gate + manual QA

- [ ] **Step 1: Run the full verification suite**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @memry/ticktick-import test
pnpm --filter @memry/desktop test:main
pnpm ipc:check
pnpm check:architecture
pnpm check:contracts
git diff --check
```

Expected: all green. Note any **pre-existing** failures unrelated to this branch (compare against `origin/main`) and do not claim them as ours.

- [ ] **Step 2: Manual QA in a dev profile**

Run: `pnpm --filter @memry/desktop dev:a`

- Open Settings → Import → "Import from TickTick (CSV)".
- Pick `/Users/h4yfans/Downloads/TickTick-backup-2026-06-15.csv`.
- Confirm: Inbox tasks land in the existing Inbox (not a duplicate project); Books/Articles/Video Tutorial projects created; Video Tutorial shows its kanban columns; a subtask nests under its parent; a completed task shows done; a tagged task shows its tag; a repeating task shows the repeat; the summary panel shows counts + any warnings.
- Confirm imported tasks survive an app restart (they were written through the indexed/sync path).

- [ ] **Step 3: Docs gate** (desktop changed)

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:ai-update --base "$base_commit"   # or hand-edit apps/docs/src
pnpm docs:impact --base "$base_commit" --strict
pnpm docs:build
```

If the change is intentionally non-docs and impact insists, use `MEMRY_DOCS_IMPACT_SKIP=1` with a one-line reason.

- [ ] **Step 4: Final commit (if docs/QA tweaks)**

```bash
git add -A
git commit -m "docs(ticktick-import): import feature docs + QA notes"
```

---

## Self-Review (author checklist — completed)

- **Spec coverage:** parser (T2), priority (T3), reminders/duration (T4), dates/tz (T5), repeat/RRULE (T6), plan types (T7), full mapping incl. inbox-bind, kanban statuses, subtasks, completion, archived, tags, positions, folder warning (T8); contract+channel (T9), apply service via domain (T10), IPC+dialog (T11), preload (T12), Settings UI + i18n (T13), verification + manual QA + docs (T14). All spec §4–§11 requirements have a task.
- **Spec deltas folded in:** (a) `repeatFrom` is `'due'` (enum), not a date; (b) import is **sequential, non-transactional** (async domain layer) with per-row skip-and-warn — supersedes the spec's "single transaction" wording (§7/§9 to be patched).
- **Placeholder scan:** every code step has real code; integration steps that depend on existing helpers name the exact file/symbol to confirm, not "TBD".
- **Type consistency:** `RepeatConfig` matches `@memry/domain-tasks`; `priority` is `0|1|2|3|4`; `TickTickImportSummary` shape is identical in contracts (T9), service return (T10), handler (T11), and renderer (T13); `mapRows(rows, { now })` signature is identical in T8 and T10.
