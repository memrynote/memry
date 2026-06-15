# Todoist CSV Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Todoist project `.csv` export into Memry as a new project with its tasks (sub-tasks, priority, best-effort due dates, comments folded into descriptions), via Settings → Import with a preview-then-confirm flow.

**Architecture:** A pure, dependency-free transform package (`@memry/todoist-import`) parses CSV → `ImportPlan`; a thin desktop service applies the plan through the existing async tasks domain (`createProject` / `createTask`); two IPC channels (`todoist-import:preview` / `:run`) + a Settings → Import UI drive it. Mirrors the sibling `import-tictick` / `notion-import` shape.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports), Vitest, Zod (contracts), Electron main `dialog`, React 19 renderer, better-sqlite3 (data DB), Drizzle.

**Spec:** `docs/superpowers/specs/2026-06-15-todoist-importer-design.md`

**Conventions (verified):**

- Prettier: single quotes, no semicolons, 100 cols, no trailing commas.
- Pure package: `package.json` with only a `typecheck` script; `tsconfig.json` extends `@memry/typescript-config/node.json` with `allowImportingTsExtensions`; imports use explicit `.ts` extensions; tests co-located as `src/*.test.ts`.
- Package tests run under the desktop vitest **`shared`** project — its `include` array is hardcoded (`apps/desktop/config/vitest.config.ts:19-30`), so a new package MUST be added there (and to `coverage.include`, `:95-108`) or its tests never run.
- Run a shared-project test file:
  `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared todoist-import`
- Run a main-process test: `… --project main import/todoist`
- Run a renderer test: `… --project renderer <name>`
- If a test throws `ERR_DLOPEN_FAILED` / NODE_MODULE_VERSION on better-sqlite3: `pnpm --filter @memry/desktop rebuild:node`.
- Logging: `createLogger('Scope')`; user-facing errors: `extractErrorMessage(err, fallback)`.
- Tailwind: logical classes only (`ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`/`text-start`).

**Domain reference (verified `packages/domain-tasks/src/commands.ts`):**

- `createTaskDomain(db) = createDesktopTasksDomain(db, createTasksPublisher(), generateId)` (see `apps/desktop/src/main/ipc/tasks-handlers.ts:31-33`).
- `await domain.createProject({ name }) → { success: true, project }` (default statuses auto-created when `statuses` omitted).
- `await domain.createTask({ projectId, title, description, priority, parentId, dueDate, dueTime, position, statusId? }) → { success: true, task }` (`task.id` is the new id; `statusId` defaults to null).
- Priority is `0|1|2|3|4` (0 none, 4 urgent).

---

## File Structure

**New — pure package `packages/todoist-import/`:**

- `package.json`, `tsconfig.json` — scaffold.
- `src/types.ts` — `TodoistRow`, `TaskPlan`, `ProjectPlan`, `ImportWarning`, `ImportStats`, `ImportPlan`.
- `src/parse-csv.ts` — RFC-4180 tokenizer + `parseTodoistCsv(text): TodoistRow[]`.
- `src/priority.ts` — `todoistPriorityToMemry(n): 0|2|3|4`.
- `src/attachments.ts` — `parseAttachmentToken`, `commentToMarkdown`.
- `src/dates.ts` — `resolveDueDate(raw, { now, lang }): { date, time } | null`.
- `src/map-rows.ts` — `mapRows(rows, projectName, { now }): ImportPlan`.
- `src/index.ts` — barrel.
- `src/*.test.ts` — co-located vitest tests + small synthetic fixtures.

**New — desktop integration:**

- `apps/desktop/src/main/import/todoist/todoist-import-service.ts` — `previewTodoistImport`, `runTodoistImport`.
- `apps/desktop/src/main/import/todoist/todoist-import-service.test.ts` — in-memory DataDb test.
- `packages/contracts/src/todoist-import-api.ts` — Zod request/response + channel constant.
- `apps/desktop/src/main/ipc/todoist-import-handlers.ts` — IPC handlers (dialog + run).
- `apps/desktop/src/preload/api/todoist-import.ts` — preload wrapper.
- `apps/desktop/src/renderer/src/components/import/use-todoist-import.ts` — renderer hook.
- `apps/desktop/src/renderer/src/components/import/todoist-import-preview-dialog.tsx` — preview UI.
- `apps/desktop/src/renderer/src/pages/settings/import-section.tsx` — Settings → Import section.

**Modified:**

- `apps/desktop/config/vitest.config.ts` — add package to `shared` include + `coverage.include`.
- `packages/contracts/src/ipc-channels.ts` — add `TodoistImportChannels`.
- `apps/desktop/src/main/ipc/index.ts` — register handlers.
- `apps/desktop/src/preload/api/index.ts` — export preload wrapper.
- `apps/desktop/src/renderer/src/pages/settings.tsx` — nav item + conditional render.
- `packages/i18n/src/locales/en/settings.json` — `import.*` strings.
- (generated) `apps/desktop/src/preload/generated/invoke-map.ts` — via `pnpm ipc:generate`.

---

## Phase A — Pure transform package

### Task 1: Scaffold `@memry/todoist-import` + wire into test runner

**Files:**

- Create: `packages/todoist-import/package.json`
- Create: `packages/todoist-import/tsconfig.json`
- Create: `packages/todoist-import/src/index.ts` (temporary stub)
- Modify: `apps/desktop/config/vitest.config.ts` (add include + coverage.include entry)
- Modify: `packages/contracts/package.json`? No. (todoist-import has no deps yet.)

- [ ] **Step 1: package.json** (mirror `packages/domain-tasks/package.json`)

```json
{
  "name": "@memry/todoist-import",
  "version": "0.1.0",
  "private": true,
  "license": "GPL-3.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json** (mirror `packages/domain-tasks/tsconfig.json`)

```json
{
  "extends": "@memry/typescript-config/node.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
}
```

- [ ] **Step 3: temporary barrel** `src/index.ts`

```ts
export {}
```

- [ ] **Step 4: register tests in the desktop `shared` vitest project**

In `apps/desktop/config/vitest.config.ts`, add to the `shared` project `include` array (after the `domain-tasks` line, ~line 24):

```ts
            '../../packages/todoist-import/src/**/*.{test,spec}.{ts,tsx}',
```

And to `coverage.include` (after the `domain-tasks` line, ~line 102):

```ts
        '../../packages/todoist-import/src/**/*.ts',
```

- [ ] **Step 5: install workspace + verify package resolves**

Run: `pnpm install` (root). Then `pnpm --filter @memry/todoist-import typecheck`
Expected: exit 0 (empty package typechecks).

- [ ] **Step 6: Commit**

```bash
git add packages/todoist-import apps/desktop/config/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(todoist-import): scaffold pure transform package"
```

---

### Task 2: `parse-csv.ts` — RFC-4180 tokenizer + header mapping

**Files:**

- Create: `packages/todoist-import/src/types.ts`
- Create: `packages/todoist-import/src/parse-csv.ts`
- Test: `packages/todoist-import/src/parse-csv.test.ts`

- [ ] **Step 1: `types.ts` (the `TodoistRow` shape only for now)**

```ts
export interface TodoistRow {
  type: 'task' | 'note' | 'section' | 'meta' | ''
  content: string
  description: string
  priority: number
  indent: number
  date: string
  dateLang: string
  timezone: string
  deadline: string
  rowNumber: number
}
```

- [ ] **Step 2: Write the failing test** `parse-csv.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseCsv, parseTodoistCsv } from './parse-csv.ts'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

describe('parseCsv', () => {
  it('splits simple rows', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']])
  })

  it('handles quoted fields with embedded commas and quotes', () => {
    const line = 'note,"[[file {""file_name"":""a,b.png"",""file_url"":""http://x/y""}]]",,'
    const rows = parseCsv(line)
    expect(rows[0][0]).toBe('note')
    expect(rows[0][1]).toBe('[[file {"file_name":"a,b.png","file_url":"http://x/y"}]]')
  })

  it('handles CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('keeps a quoted field that contains a newline', () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([['line1\nline2', 'b']])
  })
})

describe('parseTodoistCsv', () => {
  it('maps the 15 columns by header and strips a BOM', () => {
    const csv =
      '﻿' +
      HEADER +
      '\n' +
      'meta,view_style=list,,,,,,,,,,,,,\n' +
      'task,go home,,,4,1,Kaan,,,,Europe/Istanbul,,,,\n' +
      'task,repair,,,4,1,Kaan,,in 2 days,en,Europe/Istanbul,,,,\n'
    const rows = parseTodoistCsv(csv)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ type: 'meta', content: 'view_style=list' })
    expect(rows[1]).toMatchObject({ type: 'task', content: 'go home', priority: 4, indent: 1 })
    expect(rows[2]).toMatchObject({
      type: 'task',
      content: 'repair',
      date: 'in 2 days',
      dateLang: 'en',
      timezone: 'Europe/Istanbul',
      rowNumber: 4
    })
  })

  it('skips blank separator rows', () => {
    const csv = HEADER + '\n' + 'task,a,,,1,1,,,,,,,,,\n' + ',,,,,,,,,,,,,,\n'
    const rows = parseTodoistCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('task')
  })

  it('throws on a missing TYPE header', () => {
    expect(() => parseTodoistCsv('A,B,C\n1,2,3')).toThrow(/header/i)
  })
})
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared parse-csv`
Expected: FAIL — `parseCsv`/`parseTodoistCsv` not exported.

- [ ] **Step 3: Implement `parse-csv.ts`**

```ts
import type { TodoistRow } from './types.ts'

/** RFC-4180 tokenizer: handles quoted fields, embedded commas/quotes/newlines, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }
  // flush trailing field/row unless the text ended exactly on a newline
  if (field.length > 0 || row.length > 0) pushRow()
  return rows
}

const TYPES = new Set(['task', 'note', 'section', 'meta'])

/** Parse a Todoist project CSV (15 columns) into typed rows, header-mapped. */
export function parseTodoistCsv(text: string): TodoistRow[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const grid = parseCsv(clean)
  const headerIdx = grid.findIndex((r) => (r[0] ?? '').trim().toUpperCase() === 'TYPE')
  if (headerIdx === -1) throw new Error('Not a Todoist CSV: missing TYPE header row')

  const header = grid[headerIdx].map((h) => h.trim().toUpperCase())
  const col = (name: string) => header.indexOf(name)
  const idx = {
    type: col('TYPE'),
    content: col('CONTENT'),
    description: col('DESCRIPTION'),
    priority: col('PRIORITY'),
    indent: col('INDENT'),
    date: col('DATE'),
    dateLang: col('DATE_LANG'),
    timezone: col('TIMEZONE'),
    deadline: col('DEADLINE')
  }

  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
  const out: TodoistRow[] = []
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const raw = grid[r]
    const rawType = get(raw, idx.type).toLowerCase()
    const type = (TYPES.has(rawType) ? rawType : '') as TodoistRow['type']
    if (type === '') continue // blank separator / unknown row
    out.push({
      type,
      content: idx.content >= 0 ? (raw[idx.content] ?? '') : '',
      description: idx.description >= 0 ? (raw[idx.description] ?? '') : '',
      priority: parseInt(get(raw, idx.priority), 10) || 0,
      indent: parseInt(get(raw, idx.indent), 10) || 1,
      date: get(raw, idx.date),
      dateLang: get(raw, idx.dateLang),
      timezone: get(raw, idx.timezone),
      deadline: get(raw, idx.deadline),
      rowNumber: r + 1
    })
  }
  return out
}
```

Note: `content`/`description` are NOT trimmed (preserve verbatim markdown / multiline); other fields are trimmed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared parse-csv`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/todoist-import/src
git commit -m "feat(todoist-import): CSV tokenizer + header mapping"
```

---

### Task 3: `priority.ts`

**Files:**

- Create: `packages/todoist-import/src/priority.ts`
- Test: `packages/todoist-import/src/priority.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { todoistPriorityToMemry } from './priority.ts'

describe('todoistPriorityToMemry', () => {
  it('maps Todoist 4/3/2/1 to Memry 4/3/2/0', () => {
    expect(todoistPriorityToMemry(4)).toBe(4)
    expect(todoistPriorityToMemry(3)).toBe(3)
    expect(todoistPriorityToMemry(2)).toBe(2)
    expect(todoistPriorityToMemry(1)).toBe(0)
  })
  it('maps out-of-range to 0', () => {
    expect(todoistPriorityToMemry(0)).toBe(0)
    expect(todoistPriorityToMemry(9)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared priority`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
/** Todoist CSV PRIORITY (4=P1 highest … 1=P4/none) → Memry priority (0 none … 4 urgent). */
export function todoistPriorityToMemry(n: number): 0 | 2 | 3 | 4 {
  if (n === 4) return 4
  if (n === 3) return 3
  if (n === 2) return 2
  return 0
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/todoist-import/src/priority.ts packages/todoist-import/src/priority.test.ts
git commit -m "feat(todoist-import): priority mapping"
```

---

### Task 4: `attachments.ts`

**Files:**

- Create: `packages/todoist-import/src/attachments.ts`
- Test: `packages/todoist-import/src/attachments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseAttachmentToken, commentToMarkdown } from './attachments.ts'

const TOKEN =
  '[[file {"file_name":"Screenshot.png","file_size":4727,"file_type":"image/png","file_url":"https://files.todoist.com/abc/file.png","image":"https://files.todoist.com/abc/file.png"}]]'

describe('parseAttachmentToken', () => {
  it('extracts name + url from a file token', () => {
    expect(parseAttachmentToken(' ' + TOKEN)).toEqual({
      name: 'Screenshot.png',
      url: 'https://files.todoist.com/abc/file.png'
    })
  })
  it('returns null for plain text', () => {
    expect(parseAttachmentToken('just a comment')).toBeNull()
  })
  it('returns null for a malformed token', () => {
    expect(parseAttachmentToken('[[file {not json}]]')).toBeNull()
  })
})

describe('commentToMarkdown', () => {
  it('renders an attachment as a markdown link', () => {
    expect(commentToMarkdown(TOKEN)).toBe(
      '[Screenshot.png](https://files.todoist.com/abc/file.png)'
    )
  })
  it('passes plain text through (trimmed)', () => {
    expect(commentToMarkdown('  hello  ')).toBe('hello')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

```ts
export interface AttachmentRef {
  name: string
  url: string
}

const FILE_TOKEN = /^\[\[file\s+(\{[\s\S]*\})\]\]$/

/** Parse a Todoist `[[file {json}]]` attachment token → { name, url }, or null. */
export function parseAttachmentToken(content: string): AttachmentRef | null {
  const m = content.trim().match(FILE_TOKEN)
  if (!m) return null
  try {
    const obj = JSON.parse(m[1]) as { file_name?: string; file_url?: string; image?: string }
    const url = obj.file_url ?? obj.image
    if (!url) return null
    return { name: obj.file_name ?? 'attachment', url }
  } catch {
    return null
  }
}

/** Turn a Todoist comment into markdown: attachment token → link; otherwise the trimmed text. */
export function commentToMarkdown(content: string): string {
  const att = parseAttachmentToken(content)
  if (att) return `[${att.name}](${att.url})`
  return content.trim()
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/todoist-import/src/attachments.ts packages/todoist-import/src/attachments.test.ts
git commit -m "feat(todoist-import): attachment token → markdown link"
```

---

### Task 5: `dates.ts` — best-effort due-date resolution

**Files:**

- Create: `packages/todoist-import/src/dates.ts`
- Test: `packages/todoist-import/src/dates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveDueDate } from './dates.ts'

// Fixed reference: Monday 2026-06-15
const now = new Date(2026, 5, 15, 9, 0, 0)
const opts = { now, lang: 'en' }

describe('resolveDueDate', () => {
  it('returns null for empty', () => {
    expect(resolveDueDate('', opts)).toBeNull()
  })
  it('parses absolute ISO date', () => {
    expect(resolveDueDate('2026-06-20', opts)).toEqual({ date: '2026-06-20', time: null })
  })
  it('parses absolute ISO datetime → date + time', () => {
    expect(resolveDueDate('2026-06-20T17:30:00', opts)).toEqual({
      date: '2026-06-20',
      time: '17:30'
    })
  })
  it('parses today / tomorrow / yesterday', () => {
    expect(resolveDueDate('today', opts)).toEqual({ date: '2026-06-15', time: null })
    expect(resolveDueDate('tomorrow', opts)).toEqual({ date: '2026-06-16', time: null })
    expect(resolveDueDate('yesterday', opts)).toEqual({ date: '2026-06-14', time: null })
  })
  it('parses "in N days/weeks/months" (the real export values)', () => {
    expect(resolveDueDate('in 2 days', opts)).toEqual({ date: '2026-06-17', time: null })
    expect(resolveDueDate('in 7 days', opts)).toEqual({ date: '2026-06-22', time: null })
    expect(resolveDueDate('in 1 week', opts)).toEqual({ date: '2026-06-22', time: null })
    expect(resolveDueDate('in 1 month', opts)).toEqual({ date: '2026-07-15', time: null })
  })
  it('parses a named month (forward-looking when no year)', () => {
    expect(resolveDueDate('Jun 20', opts)).toEqual({ date: '2026-06-20', time: null })
    expect(resolveDueDate('20 June 2027', opts)).toEqual({ date: '2027-06-20', time: null })
  })
  it('parses a weekday → next occurrence', () => {
    // now is Mon 2026-06-15; next Wednesday = 2026-06-17
    expect(resolveDueDate('Wednesday', opts)).toEqual({ date: '2026-06-17', time: null })
  })
  it('returns null for recurring "every ..."', () => {
    expect(resolveDueDate('every day', opts)).toBeNull()
  })
  it('returns null for a non-English lang', () => {
    expect(resolveDueDate('20 Haziran', { now, lang: 'tr' })).toBeNull()
  })
  it('returns null for gibberish', () => {
    expect(resolveDueDate('someday maybe', opts)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

```ts
export interface ResolvedDate {
  date: string // YYYY-MM-DD
  time: string | null // HH:mm
}

export interface DateOptions {
  now: Date
  lang?: string
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
}
const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate())

/** Best-effort parse of a Todoist DATE string into a Memry due date (English only). */
export function resolveDueDate(raw: string, { now, lang }: DateOptions): ResolvedDate | null {
  const s = raw.trim()
  if (!s) return null
  if (lang && lang.toLowerCase() !== 'en') return null

  const lower = s.toLowerCase()
  if (lower.startsWith('every ')) return null // recurring — out of scope (v1)

  if (lower === 'today') return { date: fmt(now), time: null }
  if (lower === 'tomorrow') return { date: fmt(addDays(now, 1)), time: null }
  if (lower === 'yesterday') return { date: fmt(addDays(now, -1)), time: null }

  // ISO date / datetime
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (iso) {
    return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, time: iso[4] ? `${iso[4]}:${iso[5]}` : null }
  }

  // "in N day|week|month(s)"
  const rel = lower.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    let d: Date
    if (unit.startsWith('day')) d = addDays(now, n)
    else if (unit.startsWith('week')) d = addDays(now, n * 7)
    else d = addMonths(now, n)
    return { date: fmt(d), time: null }
  }

  // weekday name → next occurrence (today counts)
  if (WEEKDAYS[lower] !== undefined) {
    const target = WEEKDAYS[lower]
    const delta = (target - now.getDay() + 7) % 7
    return { date: fmt(addDays(now, delta)), time: null }
  }

  // named month: "Jun 20", "20 June", "June 20 2026", "20 Jun 2027"
  const named = parseNamedMonth(lower, now)
  if (named) return { date: named, time: null }

  return null
}

function parseNamedMonth(lower: string, now: Date): string | null {
  const tokens = lower.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  let month = -1
  let day = -1
  let year = -1
  for (const tok of tokens) {
    if (MONTHS[tok] !== undefined) month = MONTHS[tok]
    else if (/^\d{4}$/.test(tok)) year = parseInt(tok, 10)
    else if (/^\d{1,2}$/.test(tok)) day = parseInt(tok, 10)
  }
  if (month < 0 || day < 1 || day > 31) return null
  if (year < 0) {
    year = now.getFullYear()
    const candidate = new Date(year, month, day)
    // forward-looking: if it already passed this year, roll to next year
    if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1
  }
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/todoist-import/src/dates.ts packages/todoist-import/src/dates.test.ts
git commit -m "feat(todoist-import): best-effort due-date resolution"
```

---

### Task 6: `map-rows.ts` — rows → ImportPlan

**Files:**

- Modify: `packages/todoist-import/src/types.ts` (add plan types)
- Create: `packages/todoist-import/src/map-rows.ts`
- Test: `packages/todoist-import/src/map-rows.test.ts`

- [ ] **Step 1: Extend `types.ts`**

Append:

```ts
export interface TaskPlan {
  tempId: string
  parentTempId: string | null
  title: string
  description: string | null
  priority: 0 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
}

export interface ProjectPlan {
  name: string
}

export interface ImportWarning {
  row?: number
  message: string
}

export interface ImportStats {
  rows: number
  tasks: number
  subtasks: number
  withDueDate: number
  comments: number
  sectionsFlattened: number
  skipped: number
}

export interface ImportPlan {
  project: ProjectPlan
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: ImportStats
  sampleTitles: string[]
}
```

- [ ] **Step 2: Write the failing test** `map-rows.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mapRows } from './map-rows.ts'
import type { TodoistRow } from './types.ts'

const now = new Date(2026, 5, 15, 9, 0, 0)

function task(partial: Partial<TodoistRow>): TodoistRow {
  return {
    type: 'task',
    content: '',
    description: '',
    priority: 1,
    indent: 1,
    date: '',
    dateLang: '',
    timezone: '',
    deadline: '',
    rowNumber: 0,
    ...partial
  }
}

describe('mapRows', () => {
  it('maps the reference export (3 tasks + image note)', () => {
    const rows: TodoistRow[] = [
      { ...task({ content: 'go home', priority: 4, indent: 1, rowNumber: 4 }) },
      {
        ...task({ content: 'repair', priority: 4, date: 'in 2 days', dateLang: 'en', rowNumber: 5 })
      },
      {
        ...task({
          content: 'repair home',
          priority: 2,
          date: 'in 7 days',
          dateLang: 'en',
          rowNumber: 6
        })
      },
      {
        type: 'note',
        content:
          '[[file {"file_name":"Screenshot.png","file_url":"https://files.todoist.com/x/file.png"}]]',
        description: '',
        priority: 0,
        indent: 1,
        date: '',
        dateLang: '',
        timezone: '',
        deadline: '',
        rowNumber: 7
      }
    ]
    const plan = mapRows(rows, 'Kişisel', { now })
    expect(plan.project.name).toBe('Kişisel')
    expect(plan.tasks).toHaveLength(3)
    expect(plan.tasks[0]).toMatchObject({ title: 'go home', priority: 4, dueDate: null })
    expect(plan.tasks[1]).toMatchObject({ title: 'repair', priority: 4, dueDate: '2026-06-17' })
    expect(plan.tasks[2]).toMatchObject({
      title: 'repair home',
      priority: 2,
      dueDate: '2026-06-22'
    })
    // image note folded into the preceding task's description
    expect(plan.tasks[2].description).toContain(
      '[Screenshot.png](https://files.todoist.com/x/file.png)'
    )
    expect(plan.stats).toMatchObject({ tasks: 3, subtasks: 0, withDueDate: 2, comments: 1 })
    expect(plan.sampleTitles).toEqual(['go home', 'repair', 'repair home'])
  })

  it('resolves INDENT nesting into parentTempId', () => {
    const rows = [
      task({ content: 'parent', indent: 1 }),
      task({ content: 'child', indent: 2 }),
      task({ content: 'grandchild', indent: 3 }),
      task({ content: 'sibling', indent: 1 })
    ]
    const plan = mapRows(rows, 'P', { now })
    const [p, c, g, s] = plan.tasks
    expect(c.parentTempId).toBe(p.tempId)
    expect(g.parentTempId).toBe(c.tempId)
    expect(s.parentTempId).toBeNull()
    expect(plan.stats.subtasks).toBe(2)
  })

  it('demotes an orphan child to top-level with a warning', () => {
    const rows = [task({ content: 'deep', indent: 3 })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].parentTempId).toBeNull()
    expect(plan.warnings.some((w) => /parent/i.test(w.message))).toBe(true)
  })

  it('flattens sections with a warning and orphans following notes', () => {
    const rows: TodoistRow[] = [
      { ...task({ content: 'Section A', indent: 1, rowNumber: 2 }), type: 'section' },
      task({ content: 'under section', indent: 1, rowNumber: 3 })
    ]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0].title).toBe('under section')
    expect(plan.stats.sectionsFlattened).toBe(1)
  })

  it('uses DEADLINE when DATE is empty', () => {
    const rows = [task({ content: 'x', date: '', deadline: '2026-12-31' })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].dueDate).toBe('2026-12-31')
  })

  it('marks an empty title as (untitled) with a warning', () => {
    const rows = [task({ content: '   ' })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].title).toBe('(untitled)')
    expect(plan.warnings.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails** — Expected: FAIL (not exported).

- [ ] **Step 4: Implement `map-rows.ts`**

```ts
import type { ImportPlan, ImportWarning, TaskPlan, TodoistRow } from './types.ts'
import { todoistPriorityToMemry } from './priority.ts'
import { resolveDueDate } from './dates.ts'
import { commentToMarkdown } from './attachments.ts'

export interface MapOptions {
  now: Date
}

export function mapRows(rows: TodoistRow[], projectName: string, { now }: MapOptions): ImportPlan {
  const tasks: TaskPlan[] = []
  const warnings: ImportWarning[] = []
  const stack: TaskPlan[] = [] // index = indent level
  let lastTask: TaskPlan | null = null
  let position = 0
  let comments = 0
  let sectionsFlattened = 0
  let skipped = 0
  let withDueDate = 0
  let seq = 0

  const name = projectName.trim() || 'Imported Todoist Project'

  for (const row of rows) {
    if (row.type === 'meta') continue

    if (row.type === 'section') {
      sectionsFlattened++
      warnings.push({ row: row.rowNumber, message: `Section "${row.content.trim()}" flattened` })
      lastTask = null
      stack.length = 0
      continue
    }

    if (row.type === 'note') {
      if (!lastTask) {
        skipped++
        warnings.push({ row: row.rowNumber, message: 'Comment with no preceding task skipped' })
        continue
      }
      const md = commentToMarkdown(row.content)
      if (md) {
        lastTask.description = lastTask.description ? `${lastTask.description}\n\n${md}` : md
        comments++
      }
      continue
    }

    if (row.type !== 'task') continue

    // title
    let title = row.content.trim()
    if (!title) {
      title = '(untitled)'
      warnings.push({
        row: row.rowNumber,
        message: 'Task with empty content imported as (untitled)'
      })
    }

    // priority
    if (row.priority < 1 || row.priority > 4) {
      warnings.push({ row: row.rowNumber, message: `Unknown priority ${row.priority} → none` })
    }
    const priority = todoistPriorityToMemry(row.priority)

    // due date (DATE, fallback DEADLINE)
    let dueDate: string | null = null
    let dueTime: string | null = null
    if (row.date.trim()) {
      const r = resolveDueDate(row.date, { now, lang: row.dateLang })
      if (r) {
        dueDate = r.date
        dueTime = r.time
      } else {
        warnings.push({ row: row.rowNumber, message: `Could not parse date "${row.date.trim()}"` })
      }
    }
    if (!dueDate && row.deadline.trim()) {
      const r = resolveDueDate(row.deadline, { now, lang: 'en' })
      if (r) {
        dueDate = r.date
        dueTime = r.time
      }
    }
    if (dueDate) withDueDate++

    // hierarchy via INDENT
    const indent = Math.max(1, row.indent)
    let parentTempId: string | null = null
    if (indent > 1) {
      const parent = stack[indent - 1]
      if (parent) parentTempId = parent.tempId
      else
        warnings.push({
          row: row.rowNumber,
          message: `Sub-task "${title}" has no parent at indent ${indent - 1}; imported top-level`
        })
    }

    const taskPlan: TaskPlan = {
      tempId: `t${seq++}`,
      parentTempId,
      title,
      description: row.description.trim() || null,
      priority,
      position: position++,
      dueDate,
      dueTime
    }
    tasks.push(taskPlan)
    stack[indent] = taskPlan
    stack.length = indent + 1 // drop deeper levels
    lastTask = taskPlan
  }

  const subtasks = tasks.filter((t) => t.parentTempId !== null).length
  return {
    project: { name },
    tasks,
    warnings,
    stats: {
      rows: rows.length,
      tasks: tasks.length,
      subtasks,
      withDueDate,
      comments,
      sectionsFlattened,
      skipped
    },
    sampleTitles: tasks.slice(0, 5).map((t) => t.title)
  }
}
```

- [ ] **Step 5: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/todoist-import/src/map-rows.ts packages/todoist-import/src/map-rows.test.ts packages/todoist-import/src/types.ts
git commit -m "feat(todoist-import): map rows to import plan"
```

---

### Task 7: barrel `index.ts` + package typecheck

**Files:**

- Modify: `packages/todoist-import/src/index.ts`

- [ ] **Step 1: Replace the stub barrel**

```ts
export * from './types.ts'
export * from './parse-csv.ts'
export * from './priority.ts'
export * from './attachments.ts'
export * from './dates.ts'
export * from './map-rows.ts'
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @memry/todoist-import typecheck`
Expected: exit 0.

- [ ] **Step 3: Run all package tests**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared todoist-import`
Expected: PASS (parse-csv, priority, attachments, dates, map-rows).

- [ ] **Step 4: Commit**

```bash
git add packages/todoist-import/src/index.ts
git commit -m "feat(todoist-import): barrel exports"
```

---

## Phase B — Desktop import service

### Task 8: `todoist-import-service.ts` + integration test

**Files:**

- Create: `apps/desktop/src/main/import/todoist/todoist-import-service.ts`
- Test: `apps/desktop/src/main/import/todoist/todoist-import-service.test.ts`
- Modify: `apps/desktop/package.json` — add dep `"@memry/todoist-import": "workspace:*"`.

**First, two lookups during implementation (do NOT guess):**

1. The in-memory DataDb test helper used by existing main-process tasks tests — search `apps/desktop/src/main/**/*.test.ts` for how a real `DataDb` is built (e.g. a `createTestDataDb()` / migration helper from `@memry/storage-data`). Reuse it. If none exists, build a better-sqlite3 `:memory:` DB and run the data migrations the same way the app's `database` module does.
2. Confirm `createTasksPublisher()` works without a live BrowserWindow in tests (it should no-op IPC). If it needs a window, the test can pass a stub publisher to `createTasksDomain` directly instead of `createDesktopTasksDomain`.

- [ ] **Step 1: Add the workspace dep + install**

Add to `apps/desktop/package.json` dependencies: `"@memry/todoist-import": "workspace:*"`, then `pnpm install`.

- [ ] **Step 2: Write the failing test** (adapt the DB-setup line to the helper found above)

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// import { createTestDataDb } from '<helper found in step 0>'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { runTodoistImport, previewTodoistImport } from './todoist-import-service.ts'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

function fixtureCsv(): string {
  return (
    HEADER +
    '\n' +
    'meta,view_style=list,,,,,,,,,,,,,\n' +
    'task,parent,,,4,1,Kaan,,,,,,,,\n' +
    'task,child,,,1,2,Kaan,,,,,,,,\n' +
    'task,repair home,,,2,1,Kaan,,2026-12-31,en,Europe/Istanbul,,,,\n'
  )
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'todoist-'))
  const file = join(dir, 'Kişisel.csv')
  writeFileSync(file, fixtureCsv(), 'utf-8')
  return file
}

describe('todoist import service', () => {
  it('previews counts without writing', async () => {
    const file = writeFixture()
    const preview = await previewTodoistImport([file])
    expect(preview[0]).toMatchObject({
      projectName: 'Kişisel',
      stats: { tasks: 3, subtasks: 1 }
    })
  })

  it('creates a project + tasks + subtask via the domain', async () => {
    // const db = createTestDataDb()  // <- from the helper in step 0
    // monkeypatch requireDatabase to return db, OR refactor the service to accept a domain (see step 3)
    const file = writeFixture()
    const summary = await runTodoistImport([file])
    expect(summary.files[0].projectName).toBe('Kişisel')
    expect(summary.files[0].projectId).toBeTruthy()
    // verify via the domain that the project now has 3 tasks, one with a parent
    // const domain = createDesktopTasksDomain(db, stubPublisher, generateId)
    // const tasks = domain.listTasks({ projectId: summary.files[0].projectId! })
    // expect(tasks.filter(t => t.parentId).length).toBe(1)
  })
})
```

- [ ] **Step 3: Implement `todoist-import-service.ts`**

To keep it unit-testable, the service takes an optional domain factory + clock (defaults wire the real desktop deps):

```ts
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseTodoistCsv, mapRows, type ImportPlan, type ImportStats } from '@memry/todoist-import'
import { requireDatabase, type DataDb } from '../../database'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { generateId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import { extractErrorMessage } from '../../lib/errors'

const logger = createLogger('TodoistImport')

type TasksDomain = ReturnType<typeof createDesktopTasksDomain>

export interface PreviewFile {
  fileName: string
  projectName: string
  stats: ImportStats
  sampleTitles: string[]
  warnings: string[]
  error?: string
}

export interface ImportFileResult {
  projectName: string
  projectId: string | null
  stats: ImportStats
  warnings: string[]
  error?: string
}

export interface ImportSummary {
  files: ImportFileResult[]
}

const emptyStats = (): ImportStats => ({
  rows: 0,
  tasks: 0,
  subtasks: 0,
  withDueDate: 0,
  comments: 0,
  sectionsFlattened: 0,
  skipped: 0
})

function projectNameFromPath(p: string): string {
  return (
    basename(p)
      .replace(/\.csv$/i, '')
      .trim() || 'Imported Todoist Project'
  )
}

async function planForFile(filePath: string, now: Date): Promise<ImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  const rows = parseTodoistCsv(raw)
  return mapRows(rows, projectNameFromPath(filePath), { now })
}

export async function previewTodoistImport(
  filePaths: string[],
  now: Date = new Date()
): Promise<PreviewFile[]> {
  const out: PreviewFile[] = []
  for (const fp of filePaths) {
    try {
      const plan = await planForFile(fp, now)
      out.push({
        fileName: basename(fp),
        projectName: plan.project.name,
        stats: plan.stats,
        sampleTitles: plan.sampleTitles,
        warnings: plan.warnings.map((w) => w.message)
      })
    } catch (err) {
      out.push({
        fileName: basename(fp),
        projectName: '',
        stats: emptyStats(),
        sampleTitles: [],
        warnings: [],
        error: extractErrorMessage(err, 'Failed to read file')
      })
    }
  }
  return out
}

export async function runTodoistImport(
  filePaths: string[],
  deps?: { domain?: TasksDomain; now?: Date }
): Promise<ImportSummary> {
  const now = deps?.now ?? new Date()
  const domain =
    deps?.domain ??
    createDesktopTasksDomain(requireDatabase() as DataDb, createTasksPublisher(), generateId)

  const files: ImportFileResult[] = []
  for (const fp of filePaths) {
    try {
      const plan = await planForFile(fp, now)
      const { project } = await domain.createProject({ name: plan.project.name })
      const idMap = new Map<string, string>()
      for (const t of plan.tasks) {
        const parentId = t.parentTempId ? (idMap.get(t.parentTempId) ?? null) : null
        const { task } = await domain.createTask({
          projectId: project.id,
          parentId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueDate: t.dueDate,
          dueTime: t.dueTime,
          position: t.position
        })
        idMap.set(t.tempId, task.id)
      }
      files.push({
        projectName: plan.project.name,
        projectId: project.id,
        stats: plan.stats,
        warnings: plan.warnings.map((w) => w.message)
      })
    } catch (err) {
      logger.error('Todoist import failed for file', fp, err)
      files.push({
        projectName: projectNameFromPath(fp),
        projectId: null,
        stats: emptyStats(),
        warnings: [],
        error: extractErrorMessage(err, 'Import failed')
      })
    }
  }
  return { files }
}
```

Note: confirm the import path for `extractErrorMessage` in the main process (search `apps/desktop/src/main` for its definition; it may be `../../lib/errors` or similar — adjust the import).

In the test (step 2), pass `{ domain }` to `runTodoistImport` built from the in-memory db so it never touches `requireDatabase()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project main import/todoist`
Expected: PASS. (If better-sqlite3 DLOPEN error → `pnpm --filter @memry/desktop rebuild:node`, re-run.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/todoist apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(todoist-import): desktop import service (preview + run)"
```

---

## Phase C — IPC contract + handler + preload

### Task 9: IPC contract + channel registry

**Files:**

- Create: `packages/contracts/src/todoist-import-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (add `TodoistImportChannels`)

- [ ] **Step 1: Add the channel constants** to `ipc-channels.ts` (near the other channel blocks)

```ts
// ============================================================================
// Todoist Import Channels
// ============================================================================

export const TodoistImportChannels = {
  invoke: {
    PREVIEW: 'todoist-import:preview',
    RUN: 'todoist-import:run'
  }
} as const
```

- [ ] **Step 2: Create `todoist-import-api.ts`** (Zod schemas; mirror `tasks-api.ts` style)

```ts
import { z } from 'zod'

export const TodoistImportStatsSchema = z.object({
  rows: z.number(),
  tasks: z.number(),
  subtasks: z.number(),
  withDueDate: z.number(),
  comments: z.number(),
  sectionsFlattened: z.number(),
  skipped: z.number()
})
export type TodoistImportStats = z.infer<typeof TodoistImportStatsSchema>

export const TodoistPreviewFileSchema = z.object({
  fileName: z.string(),
  projectName: z.string(),
  stats: TodoistImportStatsSchema,
  sampleTitles: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z.string().optional()
})
export type TodoistPreviewFile = z.infer<typeof TodoistPreviewFileSchema>

export const TodoistPreviewResponseSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    filePaths: z.array(z.string()),
    files: z.array(TodoistPreviewFileSchema)
  })
])
export type TodoistPreviewResponse = z.infer<typeof TodoistPreviewResponseSchema>

export const TodoistImportRunSchema = z.object({
  filePaths: z.array(z.string()).min(1)
})
export type TodoistImportRunInput = z.infer<typeof TodoistImportRunSchema>

export const TodoistImportFileResultSchema = z.object({
  projectName: z.string(),
  projectId: z.string().nullable(),
  stats: TodoistImportStatsSchema,
  warnings: z.array(z.string()),
  error: z.string().optional()
})

export const TodoistImportSummarySchema = z.object({
  files: z.array(TodoistImportFileResultSchema)
})
export type TodoistImportSummary = z.infer<typeof TodoistImportSummarySchema>
```

- [ ] **Step 3: Typecheck contracts**

Run: `pnpm --filter @memry/contracts typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/todoist-import-api.ts packages/contracts/src/ipc-channels.ts
git commit -m "feat(todoist-import): IPC contract + channels"
```

---

### Task 10: IPC handlers + registration

**Files:**

- Create: `apps/desktop/src/main/ipc/todoist-import-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts` (import + call `registerTodoistImportHandlers()` near `registerTasksHandlers()`; add to any `unregister`/teardown list if present)

- [ ] **Step 1: Implement the handlers** (dialog pattern mirrors `notes-handlers.ts:966-985`)

```ts
import { ipcMain, dialog } from 'electron'
import { TodoistImportChannels } from '@memry/contracts/ipc-channels'
import { TodoistImportRunSchema } from '@memry/contracts/todoist-import-api'
import { createHandler, createValidatedHandler } from './validate'
import { previewTodoistImport, runTodoistImport } from '../import/todoist/todoist-import-service'
import { createLogger } from '../lib/logger'

const logger = createLogger('IPC:TodoistImport')

export function registerTodoistImportHandlers(): void {
  ipcMain.handle(
    TodoistImportChannels.invoke.PREVIEW,
    createHandler(async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Todoist CSV', extensions: ['csv'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const }
      }
      const files = await previewTodoistImport(result.filePaths)
      return { canceled: false as const, filePaths: result.filePaths, files }
    })
  )

  ipcMain.handle(
    TodoistImportChannels.invoke.RUN,
    createValidatedHandler(TodoistImportRunSchema, async (input) => {
      logger.info('Importing Todoist files', input.filePaths.length)
      return runTodoistImport(input.filePaths)
    })
  )
}

export function unregisterTodoistImportHandlers(): void {
  Object.values(TodoistImportChannels.invoke).forEach((c) => ipcMain.removeHandler(c))
}
```

- [ ] **Step 2: Register in `apps/desktop/src/main/ipc/index.ts`**

Add the import and call alongside the other `register*Handlers()` calls (find where `registerTasksHandlers()` is invoked and add `registerTodoistImportHandlers()` next to it). Mirror the import style used in that file.

- [ ] **Step 3: Regenerate + validate the invoke map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: invoke map updated to include both channels; check passes.

- [ ] **Step 4: Typecheck node side**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/todoist-import-handlers.ts apps/desktop/src/main/ipc/index.ts apps/desktop/src/preload/generated
git commit -m "feat(todoist-import): IPC handlers + registration"
```

---

### Task 11: Preload wrapper

**Files:**

- Create: `apps/desktop/src/preload/api/todoist-import.ts`
- Modify: `apps/desktop/src/preload/api/index.ts` (export it under the api object)

**First:** read an existing simple preload wrapper (e.g. `apps/desktop/src/preload/api/*.ts` that wraps `ipcRenderer.invoke`) and `index.ts` to match the exact registration shape (namespace key, typing).

- [ ] **Step 1: Implement the wrapper** (adjust to the existing preload helper, e.g. a typed `invoke`)

```ts
import { ipcRenderer } from 'electron'
import { TodoistImportChannels } from '@memry/contracts/ipc-channels'
import type {
  TodoistImportRunInput,
  TodoistImportSummary,
  TodoistPreviewResponse
} from '@memry/contracts/todoist-import-api'

export const todoistImportApi = {
  preview: (): Promise<TodoistPreviewResponse> =>
    ipcRenderer.invoke(TodoistImportChannels.invoke.PREVIEW),
  run: (input: TodoistImportRunInput): Promise<TodoistImportSummary> =>
    ipcRenderer.invoke(TodoistImportChannels.invoke.RUN, input)
}
```

- [ ] **Step 2: Export from `preload/api/index.ts`**

Add `todoistImport: todoistImportApi` to the exposed api object (match the existing namespacing pattern, e.g. how `tasks`/`notes` are attached). Ensure `window.api.todoistImport` types flow (the preload `.d.ts` / `ipc:check` covers this).

- [ ] **Step 3: ipc:check + preload typecheck**

Run: `pnpm ipc:check && pnpm --filter @memry/desktop typecheck:node`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/api/todoist-import.ts apps/desktop/src/preload/api/index.ts
git commit -m "feat(todoist-import): preload api wrapper"
```

---

## Phase D — Renderer UI

### Task 12: Renderer hook `use-todoist-import.ts`

**Files:**

- Create: `apps/desktop/src/renderer/src/components/import/use-todoist-import.ts`
- Test: `apps/desktop/src/renderer/src/components/import/use-todoist-import.test.ts`

**First:** find the query-invalidation key for tasks/projects (search renderer for `taskKeys` / `queryKey` used after creating a project) and the toast helper (search for `toast(` usage). Use them in the hook.

- [ ] **Step 1: Write the failing test** (mock `window.api.todoistImport`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTodoistImport } from './use-todoist-import.ts'

const preview = vi.fn()
const run = vi.fn()

beforeEach(() => {
  preview.mockReset()
  run.mockReset()
  // @ts-expect-error test shim
  window.api = { todoistImport: { preview, run } }
})

describe('useTodoistImport', () => {
  it('chooseFiles stores preview files', async () => {
    preview.mockResolvedValue({
      canceled: false,
      filePaths: ['/x/Kişisel.csv'],
      files: [
        {
          fileName: 'Kişisel.csv',
          projectName: 'Kişisel',
          stats: {},
          sampleTitles: [],
          warnings: []
        }
      ]
    })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    await waitFor(() => expect(result.current.preview?.files).toHaveLength(1))
  })

  it('chooseFiles is a no-op when canceled', async () => {
    preview.mockResolvedValue({ canceled: true })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    expect(result.current.preview).toBeNull()
  })

  it('confirmImport calls run with stored paths', async () => {
    preview.mockResolvedValue({
      canceled: false,
      filePaths: ['/x/a.csv'],
      files: [{ fileName: 'a.csv', projectName: 'a', stats: {}, sampleTitles: [], warnings: [] }]
    })
    run.mockResolvedValue({
      files: [{ projectName: 'a', projectId: 'p1', stats: {}, warnings: [] }]
    })
    const { result } = renderHook(() => useTodoistImport())
    await act(async () => {
      await result.current.chooseFiles()
    })
    await act(async () => {
      await result.current.confirmImport()
    })
    expect(run).toHaveBeenCalledWith({ filePaths: ['/x/a.csv'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (not exported).

- [ ] **Step 3: Implement the hook** (wire the real toast + invalidation found above)

```ts
import { useCallback, useState } from 'react'
import type {
  TodoistImportSummary,
  TodoistPreviewResponse
} from '@memry/contracts/todoist-import-api'

type PreviewState = Extract<TodoistPreviewResponse, { canceled: false }>

export function useTodoistImport() {
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [summary, setSummary] = useState<TodoistImportSummary | null>(null)

  const chooseFiles = useCallback(async () => {
    setIsPreviewing(true)
    try {
      const res = await window.api.todoistImport.preview()
      if (!res.canceled) setPreview(res)
    } finally {
      setIsPreviewing(false)
    }
  }, [])

  const cancel = useCallback(() => {
    setPreview(null)
    setSummary(null)
  }, [])

  const confirmImport = useCallback(async () => {
    if (!preview) return
    setIsImporting(true)
    try {
      const result = await window.api.todoistImport.run({ filePaths: preview.filePaths })
      setSummary(result)
      setPreview(null)
      // TODO(impl): invalidate task/project queries + show success toast (use helpers found above)
    } finally {
      setIsImporting(false)
    }
  }, [preview])

  return { preview, isPreviewing, isImporting, summary, chooseFiles, confirmImport, cancel }
}
```

Replace the `TODO(impl)` line with the actual query-invalidation + toast calls (no placeholder left in the final code).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project renderer use-todoist-import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/import/use-todoist-import.ts apps/desktop/src/renderer/src/components/import/use-todoist-import.test.ts
git commit -m "feat(todoist-import): renderer import hook"
```

---

### Task 13: Preview dialog component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/import/todoist-import-preview-dialog.tsx`

**First:** read an existing dialog built on the shared Dialog primitive (e.g. `calendar-quick-create-dialog.tsx` referenced in CLAUDE.md, or any `*-dialog.tsx` under renderer) to match the Dialog import + Button primitives + i18n `useT` usage. Use logical Tailwind classes only.

- [ ] **Step 1: Implement** the dialog (props-driven; consumes the hook's `preview`, `isImporting`, `confirmImport`, `cancel`). Render, per file: project name, a counts line (tasks / sub-tasks / with-due / comments / skipped) from `stats`, the `sampleTitles` (first few), and a collapsible warnings list when non-empty; footer with **Cancel** + **Import** (Import disabled while `isImporting`; per the CLAUDE.md gotcha, fire from `onPointerDown` if the button disables itself mid-click). Use `t('import.*')` strings.

- [ ] **Step 2: Typecheck web**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/import/todoist-import-preview-dialog.tsx
git commit -m "feat(todoist-import): import preview dialog"
```

---

### Task 14: Settings → Import section + nav + i18n

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/settings/import-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings.tsx` (nav item + conditional render)
- Modify: `packages/i18n/src/locales/en/settings.json` (`import.*` strings)

**First:** read `apps/desktop/src/renderer/src/pages/settings.tsx` to see exactly how nav items + section renders are declared, and `apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx` (small) + `settings-primitives.tsx` for the section component shape. Match them.

- [ ] **Step 1: Implement `import-section.tsx`** using `SettingsHeader` / `SettingsGroup` / `SettingRow` primitives. It composes `useTodoistImport()` + renders the `todoist-import-preview-dialog`, with a "Choose CSV file(s)…" button (calls `chooseFiles`) and a short description. Show the post-import `summary` (projects/tasks counts) inline.

- [ ] **Step 2: Add i18n strings** to `packages/i18n/src/locales/en/settings.json`:

```json
"import": {
  "header": { "title": "Import", "subtitle": "Bring tasks in from other apps" },
  "todoist": {
    "title": "Import from Todoist",
    "description": "Choose a Todoist project CSV export. Each file becomes a new project.",
    "choose": "Choose CSV file(s)…",
    "import": "Import",
    "cancel": "Cancel",
    "counts": "{{tasks}} tasks · {{subtasks}} sub-tasks · {{withDueDate}} dated · {{comments}} comments · {{skipped}} skipped",
    "warnings": "Warnings",
    "success": "Imported {{projects}} project(s), {{tasks}} task(s)"
  }
}
```

- [ ] **Step 3: Wire the nav item + render** in `settings.tsx` (add an `'import'` section id, a `SettingsNavItem` with an appropriate icon, and `{activeSection === 'import' && <ImportSettings />}`). Match the file's existing pattern exactly.

- [ ] **Step 4: i18n check + web typecheck**

Run: `pnpm --filter @memry/desktop i18n:check && pnpm --filter @memry/desktop typecheck:web`
Expected: exit 0 (i18n gate only requires en).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/import-section.tsx apps/desktop/src/renderer/src/pages/settings.tsx packages/i18n/src/locales/en/settings.json
git commit -m "feat(todoist-import): Settings → Import section + nav"
```

---

## Phase E — Verify

### Task 15: Full verification + manual QA

- [ ] **Step 1: Lint + typecheck + targeted tests**

```bash
pnpm lint
pnpm typecheck
pnpm ipc:check
cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project shared todoist-import
cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project main import/todoist
cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project renderer use-todoist-import
git diff --check
```

Expected: all green.

- [ ] **Step 2: Manual QA in a dev profile**

Run `pnpm --filter @memry/desktop dev:a`. Open Settings → Import → Import from Todoist → choose the real `/Users/h4yfans/Downloads/Kişisel.csv`. Confirm the preview shows project "Kişisel", 3 tasks, and import creates the project with: "go home" (urgent, no date), "repair" (urgent, due in 2 days), "repair home" (medium, due in 7 days) with the screenshot link folded into its description.

- [ ] **Step 3: Docs gate (desktop change)**

```bash
pnpm docs:impact --base origin/main --strict
```

If `missing-docs`: add a short page under `apps/docs/src/**` documenting the Todoist import (Settings → Import), or run `pnpm docs:ai-update --base origin/main`, then re-run `--strict` + `pnpm docs:build`.

- [ ] **Step 4: Final commit (if docs added)**

```bash
git add apps/docs
git commit -m "docs(todoist-import): document Settings → Import"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3 ground-truth → Tasks 2/5/6; §5 data model → Tasks 2/6/8/9; §6 mapping rules → Tasks 3/4/5/6; §7 service → Task 8; §8 IPC+UX → Tasks 9/10/11/12/13/14; §9 error handling → Tasks 6/8/10; §10 testing → tests in every task; §11 decisions → all honored; §12 follow-ups → intentionally excluded.
- **Type consistency:** `ImportStats`/`TaskPlan`/`ImportPlan` defined in Task 6 are reused verbatim in Tasks 8/9; `PreviewFile`/`ImportSummary` (Task 8) mirror the Zod schemas (Task 9); `todoist-import:preview`/`:run` channel names match across Tasks 9/10/11.
- **Known soft spots flagged for implementation (not placeholders in shipped code):** the in-memory DataDb test helper (Task 8 step 0), `extractErrorMessage` import path (Task 8 step 3), toast + query-invalidation helpers (Task 12), and exact preload/api + settings-nav registration shapes (Tasks 11/13/14) are resolved by reading the named existing files before writing — each task says which file to read.
