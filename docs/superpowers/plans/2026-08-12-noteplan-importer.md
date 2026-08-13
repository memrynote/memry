# NotePlan Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a NotePlan 3 vault into Memry — daily calendar notes become real journal entries, regular notes become notes, and NotePlan tasks become real Memry task rows embedded in those bodies.

**Architecture:** Two layers, matching every existing importer. A pure, fs-free mapping package at `packages/importers/src/noteplan/` does all parsing and translation. A desktop orchestrator at `apps/desktop/src/main/import/noteplan/` does IO: walk the tree, create tasks, write notes and journal entries. Two shared helpers are extracted first because the orchestrator needs them and neither is reachable today.

**Tech Stack:** TypeScript (ESM), Vitest, gray-matter (frontmatter), Drizzle/better-sqlite3 (via existing domain APIs). No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-noteplan-importer-design.md`

## Global Constraints

- **PRODUCTION app, backward compatibility mandatory.** This plan adds no DB schema change and no migration. It only calls existing, shipped APIs.
- **Never use `pnpm add`.** It churns the lockfile and breaks all 1151 renderer tests. This plan needs no new dependency.
- **Logging:** always `createLogger('Scope')` from `../../lib/logger`. Never `console.*`.
- **The pure package must not import electron, `fs`, or any database module.** `node:path` is allowed (existing importers use it).
- **Type name collision:** `packages/importers/src/markdown/types.ts` already exports a type called `NotePlan` meaning "plan for one note". Never export a type named `NotePlan` from the noteplan package. Use the names in Task 4 verbatim.
- **Tailwind logical properties** — not applicable, this plan touches no UI.
- Commit after every task. Do not add `Co-Authored-By` trailers.

### Test commands

- Pure package (`packages/importers/**`) runs under the desktop vitest `shared` project:
  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan
  ```
- Main-process tests:
  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main <path-substring>
  ```
- Typecheck: `pnpm typecheck`

---

## File Structure

**Created — pure package** (`packages/importers/src/noteplan/`)

| File                | Responsibility                                                          |
| ------------------- | ----------------------------------------------------------------------- |
| `calendar-dates.ts` | Classify a calendar filename stem into day/week/month/quarter/year      |
| `extract-title.ts`  | Pull the first `# H1` out of a body                                     |
| `parse-tags.ts`     | Hierarchical `#tag/sub` extraction                                      |
| `map-properties.ts` | Split frontmatter into kept properties vs dropped NotePlan styling keys |
| `convert-body.ts`   | NotePlan markdown → Memry markdown + extracted tasks                    |
| `types.ts`          | Plan data shapes                                                        |
| `map-files.ts`      | Scanned files → import plan                                             |
| `index.ts`          | Barrel                                                                  |

**Created — desktop**

| File                                                         | Responsibility                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `apps/desktop/src/main/import/_shared/co-located-assets.ts`  | Resolve/save/rewrite co-located assets (lifted from the markdown importer) |
| `apps/desktop/src/main/journal/create-entry.ts`              | The journal create pipeline, callable outside IPC                          |
| `apps/desktop/src/main/import/noteplan/noteplan-importer.ts` | Orchestrator                                                               |

**Modified**

| File                                                         | Change                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `packages/importers/package.json`                            | Add `./noteplan` export                    |
| `packages/importers/src/messages.ts`                         | Add NotePlan status + warning codes        |
| `apps/desktop/src/main/import/markdown/markdown-importer.ts` | Call the extracted asset helper            |
| `apps/desktop/src/main/ipc/journal-handlers.ts`              | Call the extracted journal helper          |
| `apps/desktop/src/main/import/register-builtins.ts`          | Register the importer                      |
| `packages/i18n/src/locales/en/settings.json`                 | `import.sources.noteplan` + status strings |

---

## Task 1: Calendar filename classification

**Files:**

- Create: `packages/importers/src/noteplan/calendar-dates.ts`
- Test: `packages/importers/src/noteplan/calendar-dates.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type CalendarKind = 'day' | 'week' | 'month' | 'quarter' | 'year'`; `interface CalendarFile { kind: CalendarKind; iso?: string; label: string }`; `function classifyCalendarStem(stem: string): CalendarFile | null`. `iso` is set only for `kind: 'day'`.

- [ ] **Step 1: Write the failing test**

Create `packages/importers/src/noteplan/calendar-dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyCalendarStem } from './calendar-dates.ts'

describe('classifyCalendarStem', () => {
  it('reads a daily note stem as an ISO day', () => {
    expect(classifyCalendarStem('20260812')).toEqual({
      kind: 'day',
      iso: '2026-08-12',
      label: '2026-08-12'
    })
  })

  it('rejects a daily stem that is not a real calendar date', () => {
    expect(classifyCalendarStem('20260231')).toBeNull()
    expect(classifyCalendarStem('20261301')).toBeNull()
    expect(classifyCalendarStem('20260800')).toBeNull()
  })

  it('reads weekly, monthly, quarterly and yearly stems', () => {
    expect(classifyCalendarStem('2026-W33')).toEqual({ kind: 'week', label: '2026-W33' })
    expect(classifyCalendarStem('2026-08')).toEqual({ kind: 'month', label: '2026-08' })
    expect(classifyCalendarStem('2026-Q3')).toEqual({ kind: 'quarter', label: '2026-Q3' })
    expect(classifyCalendarStem('2026')).toEqual({ kind: 'year', label: '2026' })
  })

  it('rejects out-of-range week, month and quarter numbers', () => {
    expect(classifyCalendarStem('2026-W00')).toBeNull()
    expect(classifyCalendarStem('2026-W54')).toBeNull()
    expect(classifyCalendarStem('2026-13')).toBeNull()
    expect(classifyCalendarStem('2026-00')).toBeNull()
    expect(classifyCalendarStem('2026-Q5')).toBeNull()
  })

  it('rejects anything that is not a calendar stem', () => {
    expect(classifyCalendarStem('start-here')).toBeNull()
    expect(classifyCalendarStem('')).toBeNull()
    expect(classifyCalendarStem('2026-08-12')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan/calendar-dates
```

Expected: FAIL — cannot resolve `./calendar-dates.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/importers/src/noteplan/calendar-dates.ts`:

```ts
/**
 * NotePlan calendar filename classification.
 *
 * NotePlan names its calendar files by period: `20260812.txt` for a day,
 * `2026-W33` / `2026-08` / `2026-Q3` / `2026` for the wider ones. Only day
 * files map onto a Memry journal entry (the journal is day-keyed); the rest
 * become ordinary notes.
 *
 * Pure — no fs access.
 */

export type CalendarKind = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface CalendarFile {
  kind: CalendarKind
  /** ISO `YYYY-MM-DD`. Set only when `kind` is `'day'`. */
  iso?: string
  /** Display label — used verbatim as the note title for non-day files. */
  label: string
}

const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/
const WEEK_RE = /^(\d{4})-W(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/
const QUARTER_RE = /^(\d{4})-Q([1-4])$/
const YEAR_RE = /^\d{4}$/

/** True when y-m-d is a real calendar date (rejects 2026-02-31, month 13, day 0). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

export function classifyCalendarStem(stem: string): CalendarFile | null {
  const day = DAY_RE.exec(stem)
  if (day) {
    const [, y, m, d] = day
    if (!isRealDate(Number(y), Number(m), Number(d))) return null
    const iso = `${y}-${m}-${d}`
    return { kind: 'day', iso, label: iso }
  }

  const week = WEEK_RE.exec(stem)
  if (week) {
    const w = Number(week[2])
    // ISO 8601 allows weeks 1–53.
    if (w < 1 || w > 53) return null
    return { kind: 'week', label: stem }
  }

  const quarter = QUARTER_RE.exec(stem)
  if (quarter) return { kind: 'quarter', label: stem }

  // Checked after the week and quarter forms, which are also `YYYY-XX`.
  const month = MONTH_RE.exec(stem)
  if (month) {
    const m = Number(month[2])
    if (m < 1 || m > 12) return null
    return { kind: 'month', label: stem }
  }

  if (YEAR_RE.test(stem)) return { kind: 'year', label: stem }

  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan/calendar-dates
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/importers/src/noteplan/calendar-dates.ts packages/importers/src/noteplan/calendar-dates.test.ts
git commit -m "feat(import): classify NotePlan calendar filenames"
```

---

## Task 2: Title, tags and property mapping

**Files:**

- Create: `packages/importers/src/noteplan/extract-title.ts`
- Create: `packages/importers/src/noteplan/parse-tags.ts`
- Create: `packages/importers/src/noteplan/map-properties.ts`
- Test: `packages/importers/src/noteplan/extract-title.test.ts`
- Test: `packages/importers/src/noteplan/parse-tags.test.ts`
- Test: `packages/importers/src/noteplan/map-properties.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `function firstHeading(body: string): string | null`; `function stripFirstHeading(body: string): string`; `function parseTags(body: string): string[]`; `function mapProperties(frontmatter: Record<string, unknown>): { properties: Record<string, unknown>; dropped: string[] }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/importers/src/noteplan/extract-title.test.ts`:

````ts
import { describe, it, expect } from 'vitest'
import { firstHeading } from './extract-title.ts'

describe('firstHeading', () => {
  it('returns the first H1 text', () => {
    expect(firstHeading('# Start Here\nsome body')).toBe('Start Here')
  })

  it('ignores deeper headings and only takes H1', () => {
    expect(firstHeading('## Agenda\n# Real Title')).toBe('Real Title')
  })

  it('ignores an H1 inside a fenced code block', () => {
    expect(firstHeading('```\n# not a title\n```\n# Real Title')).toBe('Real Title')
  })

  it('returns null when there is no H1', () => {
    expect(firstHeading('just text\n- a bullet')).toBeNull()
  })
})

describe('stripFirstHeading', () => {
  it('removes exactly the line firstHeading found', () => {
    expect(stripFirstHeading('# Start Here\nsome body')).toBe('some body')
  })

  it('leaves an identical line inside a code fence alone', () => {
    expect(stripFirstHeading('```\n# Real Title\n```\n# Real Title\nbody')).toBe(
      '```\n# Real Title\n```\nbody'
    )
  })

  it('returns the body unchanged when there is no H1', () => {
    expect(stripFirstHeading('just text')).toBe('just text')
  })
})
````

Add `stripFirstHeading` to the import at the top of that test file:

```ts
import { firstHeading, stripFirstHeading } from './extract-title.ts'
```

Create `packages/importers/src/noteplan/parse-tags.test.ts`:

````ts
import { describe, it, expect } from 'vitest'
import { parseTags } from './parse-tags.ts'

describe('parseTags', () => {
  it('extracts hierarchical hashtags', () => {
    expect(parseTags('Source: #blogs/jamesclear, [[A Thousand Brains]]')).toEqual([
      'blogs/jamesclear'
    ])
  })

  it('extracts several tags and sorts them, deduplicated', () => {
    expect(parseTags('#books/decisive and #books/happinesshypothesis and #books/decisive')).toEqual(
      ['books/decisive', 'books/happinesshypothesis']
    )
  })

  it('does not treat markdown headings as tags', () => {
    expect(parseTags('# Heading\n## Sub heading')).toEqual([])
  })

  it('does not treat a mid-word hash as a tag', () => {
    expect(parseTags('issue no#42 here')).toEqual([])
  })

  it('ignores hashtags inside fenced code blocks', () => {
    expect(parseTags('```\nconst x = 1 // #nottag\n```\ntext #real')).toEqual(['real'])
  })
})
````

Create `packages/importers/src/noteplan/map-properties.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapProperties } from './map-properties.ts'

describe('mapProperties', () => {
  it('keeps semantic keys and drops NotePlan styling keys', () => {
    const result = mapProperties({
      type: 'area',
      status: 'Active',
      owner: 'Web',
      icon: 'truck',
      'icon-color': 'purple-600',
      'bg-color': 'purple-50',
      'bg-color-dark': 'purple-950',
      'bg-pattern': 'dotted'
    })

    expect(result.properties).toEqual({ type: 'area', status: 'Active', owner: 'Web' })
    expect(result.dropped).toEqual([
      'bg-color',
      'bg-color-dark',
      'bg-pattern',
      'icon',
      'icon-color'
    ])
  })

  it('returns empty results for empty frontmatter', () => {
    expect(mapProperties({})).toEqual({ properties: {}, dropped: [] })
  })

  it('drops undefined values', () => {
    expect(mapProperties({ type: 'guide', owner: undefined })).toEqual({
      properties: { type: 'guide' },
      dropped: []
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan
```

Expected: FAIL — the three modules do not resolve.

- [ ] **Step 3: Write the implementations**

Create `packages/importers/src/noteplan/extract-title.ts`:

````ts
/**
 * NotePlan's real note title is the first `# H1` line of the body, not the
 * filename — `start-here.txt` opens as "Start Here". Wikilinks resolve by
 * title on both sides, so preserving this is what keeps `[[Start Here]]`
 * working after import.
 *
 * Pure — no fs access.
 */

const FENCE_RE = /^\s*(```|~~~)/
const H1_RE = /^#\s+(.+?)\s*$/

/** Index of the first H1 line outside any code fence, or -1. */
function headingLineIndex(lines: string[]): number {
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (H1_RE.test(lines[i])) return i
  }
  return -1
}

export function firstHeading(body: string): string | null {
  const lines = body.split('\n')
  const index = headingLineIndex(lines)
  if (index === -1) return null
  return H1_RE.exec(lines[index])![1]
}

/**
 * Drop the H1 line `firstHeading` found. The title moves onto the note itself,
 * so leaving it in the body would render it twice. Removes that exact line —
 * never a same-looking line inside a code fence.
 */
export function stripFirstHeading(body: string): string {
  const lines = body.split('\n')
  const index = headingLineIndex(lines)
  if (index === -1) return body
  lines.splice(index, 1)
  // A blank line left where the heading was would open the body with a gap.
  if (lines[index] === '') lines.splice(index, 1)
  return lines.join('\n')
}
````

Create `packages/importers/src/noteplan/parse-tags.ts`:

````ts
/**
 * NotePlan hashtags, including the hierarchical `#books/decisive` form.
 *
 * Mirrors `bear/parse-tags.ts` minus Bear's `#[enclosed tag]#` syntax, which
 * NotePlan does not have. Pure — no fs access.
 */

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^#{1,6}\s/
// `(?<!\S)` anchors the tag to a word boundary so `no#42` is not a tag. The
// character class carries `/` so hierarchical tags stay whole.
const TAG_RE = /(?<!\S)#([\p{L}\p{N}/\-_]+)/gu

export function parseTags(body: string): string[] {
  const seen = new Set<string>()
  let inFence = false

  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // A markdown heading opens with `#` + space; a tag never does.
    if (HEADING_RE.test(line.trimStart())) continue

    for (const match of line.matchAll(TAG_RE)) {
      const tag = match[1]
      if (tag) seen.add(tag)
    }
  }

  return Array.from(seen).sort()
}
````

Create `packages/importers/src/noteplan/map-properties.ts`:

```ts
/**
 * NotePlan frontmatter mixes real note properties (`type`, `status`, `owner`)
 * with keys that only drive NotePlan's own note styling. The styling keys
 * carry no meaning in Memry and would show up as noise in the properties
 * panel, so they are dropped — and reported, so the import summary can say so.
 *
 * Pure — no fs access.
 */

/** Frontmatter keys that exist purely to style a note inside NotePlan. */
const STYLING_KEYS = new Set(['icon', 'icon-color', 'bg-color', 'bg-color-dark', 'bg-pattern'])

export function mapProperties(frontmatter: Record<string, unknown>): {
  properties: Record<string, unknown>
  dropped: string[]
} {
  const properties: Record<string, unknown> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(frontmatter)) {
    if (STYLING_KEYS.has(key)) {
      dropped.push(key)
      continue
    }
    if (value === undefined) continue
    properties[key] = value
  }

  return { properties, dropped: dropped.sort() }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan
```

Expected: PASS, 20 tests — 5 calendar (Task 1) + 4 `firstHeading` + 3 `stripFirstHeading` + 5 tags + 3 properties.

- [ ] **Step 5: Commit**

```bash
git add packages/importers/src/noteplan/
git commit -m "feat(import): NotePlan title, tag and property mapping"
```

---

## Task 3: Body conversion and task extraction

This is the core of the importer. NotePlan's list markers are inverted relative to plain markdown: `*` is a task, `+` is a checklist, `-` is a plain bullet.

**Files:**

- Create: `packages/importers/src/noteplan/convert-body.ts`
- Test: `packages/importers/src/noteplan/convert-body.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:

  ```ts
  interface ParsedTask {
    tempId: string
    title: string
    state: 'open' | 'done' | 'cancelled'
    dueDate: string | null // YYYY-MM-DD
    completedAt: string | null // YYYY-MM-DD
    parentTempId: string | null
  }
  interface ConvertedBody {
    markdown: string
    tasks: ParsedTask[]
  }
  function convertBody(source: string): ConvertedBody
  const TASK_PLACEHOLDER_PREFIX = '{np-task:'
  function taskPlaceholder(tempId: string): string
  ```

  The emitted markdown carries `{np-task:<tempId>}` at the end of every task line. Task 7 replaces each with `{task:<realId>}`.

- [ ] **Step 1: Write the failing test**

Create `packages/importers/src/noteplan/convert-body.test.ts`:

````ts
import { describe, it, expect } from 'vitest'
import { convertBody, taskPlaceholder } from './convert-body.ts'

describe('convertBody — markers', () => {
  it('turns `*` into a task checkbox with a placeholder', () => {
    const result = convertBody('* Buy milk')
    expect(result.markdown).toBe(`- [ ] Buy milk ${taskPlaceholder('t0')}`)
    expect(result.tasks).toEqual([
      {
        tempId: 't0',
        title: 'Buy milk',
        state: 'open',
        dueDate: null,
        completedAt: null,
        parentTempId: null
      }
    ])
  })

  it('reads done, cancelled and scheduled task states', () => {
    const result = convertBody('* [x] Done thing\n* [-] Dropped thing\n* [>] Moved thing')
    expect(result.tasks.map((t) => t.state)).toEqual(['done', 'cancelled', 'open'])
    // Cancelled renders checked so the checkbox reads as "not outstanding".
    expect(result.markdown.split('\n')[1]).toBe(`- [x] Dropped thing ${taskPlaceholder('t1')}`)
  })

  it('turns `+` into a plain checkbox with no task row', () => {
    const result = convertBody('+ 08:00 - 09:00 Reply to emails\n+ [x] Stakeholders confirmed')
    expect(result.markdown).toBe(
      '- [ ] 08:00 - 09:00 Reply to emails\n- [x] Stakeholders confirmed'
    )
    expect(result.tasks).toEqual([])
  })

  it('leaves `-` bullets alone', () => {
    const result = convertBody('- just a bullet')
    expect(result.markdown).toBe('- just a bullet')
    expect(result.tasks).toEqual([])
  })
})

describe('convertBody — dates', () => {
  it('lifts `>YYYY-MM-DD` out of the title into dueDate', () => {
    const result = convertBody('* Project kickoff >2025-11-03')
    expect(result.tasks[0].title).toBe('Project kickoff')
    expect(result.tasks[0].dueDate).toBe('2025-11-03')
    expect(result.markdown).toBe(`- [ ] Project kickoff ${taskPlaceholder('t0')}`)
  })

  it('lifts `@done(...)` out of the title into completedAt', () => {
    const result = convertBody('* [x] Ship it @done(2025-11-04 14:30)')
    expect(result.tasks[0].title).toBe('Ship it')
    expect(result.tasks[0].completedAt).toBe('2025-11-04')
    expect(result.tasks[0].state).toBe('done')
  })

  it('ignores a `>date` on a non-task line', () => {
    const result = convertBody('- see you >2025-11-03')
    expect(result.markdown).toBe('- see you >2025-11-03')
    expect(result.tasks).toEqual([])
  })
})

describe('convertBody — nesting', () => {
  it('converts tab indentation to two spaces per level', () => {
    const result = convertBody('* Parent\n\t* Child\n\t\t* Grandchild')
    expect(result.markdown.split('\n')).toEqual([
      `- [ ] Parent ${taskPlaceholder('t0')}`,
      `  - [ ] Child ${taskPlaceholder('t1')}`,
      `    - [ ] Grandchild ${taskPlaceholder('t2')}`
    ])
  })

  it('links nested tasks to the nearest shallower task', () => {
    const result = convertBody('* Parent\n\t* Child\n\t\t* Grandchild\n* Sibling')
    expect(result.tasks.map((t) => [t.tempId, t.parentTempId])).toEqual([
      ['t0', null],
      ['t1', 't0'],
      ['t2', 't1'],
      ['t3', null]
    ])
  })

  it('links a task nested under a checklist to the nearest shallower task', () => {
    const result = convertBody('* Parent\n\t+ a checklist step\n\t\t* Deep task')
    expect(result.tasks.map((t) => [t.tempId, t.parentTempId])).toEqual([
      ['t0', null],
      ['t1', 't0']
    ])
  })
})

describe('convertBody — pass-through', () => {
  it('leaves headings, tables, quotes and paragraphs untouched', () => {
    const source = '# Title\n\n> a quote\n\n| a | b |\n| - | - |\n\nplain text'
    expect(convertBody(source).markdown).toBe(source)
  })

  it('does not convert list markers inside a fenced code block', () => {
    const source = '```js\n* not a task\n+ not a checklist\n```'
    const result = convertBody(source)
    expect(result.markdown).toBe(source)
    expect(result.tasks).toEqual([])
  })

  it('leaves a `---` horizontal rule alone', () => {
    expect(convertBody('---').markdown).toBe('---')
  })

  it('preserves a trailing newline', () => {
    expect(convertBody('* Task\n').markdown).toBe(`- [ ] Task ${taskPlaceholder('t0')}\n`)
  })
})
````

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan/convert-body
```

Expected: FAIL — cannot resolve `./convert-body.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/importers/src/noteplan/convert-body.ts`:

````ts
/**
 * NotePlan markdown → Memry markdown, with tasks lifted out.
 *
 * NotePlan's list markers are inverted relative to plain markdown:
 *   `*` is a task, `+` is a checklist, `-` is a plain bullet.
 * Only `*` lines become real Memry task rows. Checklists carry NotePlan's
 * timeblocks and micro-steps (`+ 08:00 - 09:00 Reply to emails`); promoting
 * them would flood the Inbox project, so they survive as plain markdown
 * checkboxes instead.
 *
 * This module stays id-free: every task line ends with a
 * `{np-task:<tempId>}` placeholder, and the orchestrator swaps in the real
 * `{task:<id>}` suffix once the rows exist. Pure — no fs access.
 */

export interface ParsedTask {
  /** Stable within one `convertBody` call: `t0`, `t1`, … */
  tempId: string
  title: string
  state: 'open' | 'done' | 'cancelled'
  /** From a `>YYYY-MM-DD` token in the line. */
  dueDate: string | null
  /** From an `@done(YYYY-MM-DD)` token in the line. */
  completedAt: string | null
  /** Nearest shallower task, by indentation. */
  parentTempId: string | null
}

export interface ConvertedBody {
  markdown: string
  tasks: ParsedTask[]
}

export const TASK_PLACEHOLDER_PREFIX = '{np-task:'

export function taskPlaceholder(tempId: string): string {
  return `${TASK_PLACEHOLDER_PREFIX}${tempId}}`
}

const FENCE_RE = /^\s*(```|~~~)/
/** Marker plus at least one space — so a `---` rule is never a list item. */
const LIST_RE = /^([ \t]*)([*+-]) +(.*)$/
const STATE_RE = /^\[([ xX>-])\] */
const DUE_RE = / *>(\d{4}-\d{2}-\d{2})\b/
const DONE_RE = / *@done\((\d{4}-\d{2}-\d{2})(?:[ T][^)]*)?\)/

/**
 * Indent depth in levels. NotePlan writes tabs; a file touched by another
 * editor may carry spaces, so four spaces also count as one level.
 */
function indentDepth(indent: string): number {
  let tabs = 0
  let spaces = 0
  for (const ch of indent) {
    if (ch === '\t') tabs++
    else spaces++
  }
  return tabs + Math.floor(spaces / 4)
}

export function convertBody(source: string): ConvertedBody {
  const lines = source.split('\n')
  const out: string[] = []
  const tasks: ParsedTask[] = []
  /** Open tasks by depth, so a nested task can find its parent. */
  const stack: { depth: number; tempId: string }[] = []
  let inFence = false
  let counter = 0

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    const list = LIST_RE.exec(line)
    if (!list) {
      out.push(line)
      continue
    }

    const [, indent, marker, rest] = list
    const depth = indentDepth(indent)
    const pad = '  '.repeat(depth)

    // `-` is a plain bullet in NotePlan; re-emit it with normalised indent.
    if (marker === '-') {
      out.push(`${pad}- ${rest}`)
      continue
    }

    const stateMatch = STATE_RE.exec(rest)
    const box = stateMatch?.[1] ?? null
    const body = stateMatch ? rest.slice(stateMatch[0].length) : rest

    // `+` is a checklist: a plain checkbox, never a task row.
    if (marker === '+') {
      const checked = box === 'x' || box === 'X'
      out.push(`${pad}- [${checked ? 'x' : ' '}] ${body}`)
      continue
    }

    // `*` is a task.
    let state: ParsedTask['state'] = 'open'
    if (box === 'x' || box === 'X') state = 'done'
    else if (box === '-') state = 'cancelled'
    // `[>]` is "moved to another day" — still an open task.

    let title = body
    let dueDate: string | null = null
    let completedAt: string | null = null

    const done = DONE_RE.exec(title)
    if (done) {
      completedAt = done[1]
      title = title.replace(DONE_RE, '')
    }

    const due = DUE_RE.exec(title)
    if (due) {
      dueDate = due[1]
      title = title.replace(DUE_RE, '')
    }

    title = title.trim()

    // Nearest shallower task is the parent; anything at or below this depth
    // is a sibling or a closed branch.
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parentTempId = stack.length > 0 ? stack[stack.length - 1].tempId : null

    const tempId = `t${counter++}`
    stack.push({ depth, tempId })
    tasks.push({ tempId, title, state, dueDate, completedAt, parentTempId })

    const checked = state === 'open' ? ' ' : 'x'
    out.push(`${pad}- [${checked}] ${title} ${taskPlaceholder(tempId)}`)
  }

  return { markdown: out.join('\n'), tasks }
}
````

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan/convert-body
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/importers/src/noteplan/convert-body.ts packages/importers/src/noteplan/convert-body.test.ts
git commit -m "feat(import): convert NotePlan markdown and extract tasks"
```

---

## Task 4: Import plan and package barrel

**Files:**

- Create: `packages/importers/src/noteplan/types.ts`
- Create: `packages/importers/src/noteplan/map-files.ts`
- Create: `packages/importers/src/noteplan/index.ts`
- Test: `packages/importers/src/noteplan/map-files.test.ts`
- Modify: `packages/importers/package.json`

**Interfaces:**

- Consumes: `classifyCalendarStem` (Task 1).
- Produces:

  ```ts
  type NotePlanArea = 'calendar' | 'notes' | 'archive'
  interface ScannedFile {
    relPath: string
    absPath: string
    rootDir: string
    area: NotePlanArea
  }
  interface PlannedNote {
    absPath: string
    rootDir: string
    title: string
    vaultFolder: string
  }
  interface PlannedJournal {
    absPath: string
    rootDir: string
    date: string
  }
  interface SkippedFile {
    item: string
    reason: string
  }
  interface NotePlanImportPlan {
    notes: PlannedNote[]
    journals: PlannedJournal[]
    skipped: SkippedFile[]
  }
  function mapFiles(files: ScannedFile[]): NotePlanImportPlan
  ```

  `relPath` is relative to the _area_ directory, not the selection root — the orchestrator (Task 7) strips `Notes/`, `Calendar/` or `@Archive/` before building each `ScannedFile`.
  `PlannedNote.title` is a **filename-derived fallback**; the orchestrator overrides it with `firstHeading(body)` when the file has an H1.

- [ ] **Step 1: Write the failing test**

Create `packages/importers/src/noteplan/map-files.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapFiles } from './map-files.ts'
import type { ScannedFile } from './types.ts'

function file(area: ScannedFile['area'], relPath: string): ScannedFile {
  return { area, relPath, absPath: `/src/${relPath}`, rootDir: '/src' }
}

describe('mapFiles', () => {
  it('routes a daily calendar file to a journal entry', () => {
    const plan = mapFiles([file('calendar', '20260812.txt')])
    expect(plan.journals).toEqual([
      { absPath: '/src/20260812.txt', rootDir: '/src', date: '2026-08-12' }
    ])
    expect(plan.notes).toEqual([])
  })

  it('routes weekly, monthly, quarterly and yearly files to NotePlan/Calendar notes', () => {
    const plan = mapFiles([
      file('calendar', '2026-W33.txt'),
      file('calendar', '2026-08.txt'),
      file('calendar', '2026-Q3.txt'),
      file('calendar', '2026.txt')
    ])
    expect(plan.journals).toEqual([])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['2026-W33', 'NotePlan/Calendar'],
      ['2026-08', 'NotePlan/Calendar'],
      ['2026-Q3', 'NotePlan/Calendar'],
      ['2026', 'NotePlan/Calendar']
    ])
  })

  it('skips a calendar file whose name is not a calendar period', () => {
    const plan = mapFiles([file('calendar', 'scratch.txt')])
    expect(plan.notes).toEqual([])
    expect(plan.journals).toEqual([])
    expect(plan.skipped).toEqual([
      { item: 'scratch.txt', reason: 'Not a NotePlan calendar filename' }
    ])
  })

  it('mirrors the Notes folder tree under NotePlan/', () => {
    const plan = mapFiles([
      file('notes', 'start-here.txt'),
      file('notes', '10 - Projects/project-sample-1.txt'),
      file('notes', '30 - Resources/Manual/templating.txt')
    ])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['start-here', 'NotePlan'],
      ['project-sample-1', 'NotePlan/10 - Projects'],
      ['templating', 'NotePlan/30 - Resources/Manual']
    ])
  })

  it('puts archived notes under NotePlan/Archive', () => {
    const plan = mapFiles([file('archive', 'old/done-project.txt')])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['done-project', 'NotePlan/Archive/old']
    ])
  })

  it('accepts .md as well as .txt and skips anything else', () => {
    const plan = mapFiles([file('notes', 'a.md'), file('notes', 'b.pdf')])
    expect(plan.notes.map((n) => n.title)).toEqual(['a'])
    expect(plan.skipped).toEqual([{ item: 'b.pdf', reason: 'Unsupported file type' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan/map-files
```

Expected: FAIL — cannot resolve `./map-files.ts`.

- [ ] **Step 3: Write the implementations**

Create `packages/importers/src/noteplan/types.ts`:

```ts
/**
 * Data shapes for the NotePlan import transform.
 *
 * Pure data — no electron / fs / db dependencies. Note that
 * `markdown/types.ts` in this same package already exports a type called
 * `NotePlan` (meaning "plan for one note"), so nothing here may reuse that
 * name.
 */

/** Which top-level NotePlan directory a file came from. */
export type NotePlanArea = 'calendar' | 'notes' | 'archive'

/** One file found during the scan. */
export interface ScannedFile {
  /** Path relative to the *area* directory, e.g. `10 - Projects/x.txt`. */
  relPath: string
  absPath: string
  /** The folder the user selected — bounds asset resolution. */
  rootDir: string
  area: NotePlanArea
}

/** A file that will become a note. */
export interface PlannedNote {
  absPath: string
  rootDir: string
  /** Filename-derived fallback; the orchestrator prefers the body's H1. */
  title: string
  /** Vault folder, e.g. `NotePlan/10 - Projects`. */
  vaultFolder: string
}

/** A file that will become a journal entry. */
export interface PlannedJournal {
  absPath: string
  rootDir: string
  /** ISO `YYYY-MM-DD`. */
  date: string
}

export interface SkippedFile {
  item: string
  reason: string
}

export interface NotePlanImportPlan {
  notes: PlannedNote[]
  journals: PlannedJournal[]
  skipped: SkippedFile[]
}
```

Create `packages/importers/src/noteplan/map-files.ts`:

```ts
/**
 * Scanned NotePlan files → an import plan.
 *
 * Daily calendar files become journal entries (Memry's journal is day-keyed);
 * every other calendar period, every regular note and every archived note
 * becomes an ordinary note under `NotePlan/`.
 *
 * Pure — no fs access.
 */

import * as path from 'path'
import { classifyCalendarStem } from './calendar-dates.ts'
import type { NotePlanImportPlan, PlannedNote, PlannedJournal, ScannedFile } from './types.ts'

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md'])

const ROOT_FOLDER = 'NotePlan'
const CALENDAR_FOLDER = `${ROOT_FOLDER}/Calendar`
const ARCHIVE_FOLDER = `${ROOT_FOLDER}/Archive`

/** `10 - Projects/x.txt` under `notes` → `NotePlan/10 - Projects`. */
function noteFolder(relPath: string, base: string): string {
  const dir = path.dirname(relPath)
  if (dir === '.') return base
  return `${base}/${dir}`
}

export function mapFiles(files: ScannedFile[]): NotePlanImportPlan {
  const notes: PlannedNote[] = []
  const journals: PlannedJournal[] = []
  const skipped: NotePlanImportPlan['skipped'] = []

  for (const file of files) {
    const ext = path.extname(file.relPath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped.push({ item: file.relPath, reason: 'Unsupported file type' })
      continue
    }

    const stem = path.basename(file.relPath, ext)

    if (file.area === 'calendar') {
      const calendar = classifyCalendarStem(stem)
      if (!calendar) {
        skipped.push({ item: file.relPath, reason: 'Not a NotePlan calendar filename' })
        continue
      }
      if (calendar.kind === 'day' && calendar.iso) {
        journals.push({ absPath: file.absPath, rootDir: file.rootDir, date: calendar.iso })
        continue
      }
      // Weekly / monthly / quarterly / yearly have no journal equivalent.
      notes.push({
        absPath: file.absPath,
        rootDir: file.rootDir,
        title: calendar.label,
        vaultFolder: CALENDAR_FOLDER
      })
      continue
    }

    const base = file.area === 'archive' ? ARCHIVE_FOLDER : ROOT_FOLDER
    notes.push({
      absPath: file.absPath,
      rootDir: file.rootDir,
      title: stem,
      vaultFolder: noteFolder(file.relPath, base)
    })
  }

  return { notes, journals, skipped }
}
```

Create `packages/importers/src/noteplan/index.ts`:

```ts
export { classifyCalendarStem } from './calendar-dates.ts'
export type { CalendarFile, CalendarKind } from './calendar-dates.ts'
export { firstHeading, stripFirstHeading } from './extract-title.ts'
export { parseTags } from './parse-tags.ts'
export { mapProperties } from './map-properties.ts'
export { convertBody, taskPlaceholder, TASK_PLACEHOLDER_PREFIX } from './convert-body.ts'
export type { ConvertedBody, ParsedTask } from './convert-body.ts'
export { mapFiles } from './map-files.ts'
export type {
  NotePlanArea,
  NotePlanImportPlan,
  PlannedJournal,
  PlannedNote,
  ScannedFile,
  SkippedFile
} from './types.ts'
```

- [ ] **Step 4: Add the package export**

In `packages/importers/package.json`, inside `"exports"`, add the entry in alphabetical position (between `"./markdown"` and `"./messages"`):

```json
    "./noteplan": "./src/noteplan/index.ts",
```

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan
pnpm typecheck
```

Expected: all noteplan tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/importers/src/noteplan/ packages/importers/package.json
git commit -m "feat(import): NotePlan import plan mapping"
```

---

## Task 5: Extract the co-located asset helper

The markdown importer resolves, saves and rewrites co-located assets inline, including a `realpath`-based traversal guard. NotePlan needs the identical behaviour. Lift it into `_shared/` and have both call it.

**Files:**

- Create: `apps/desktop/src/main/import/_shared/co-located-assets.ts`
- Modify: `apps/desktop/src/main/import/markdown/markdown-importer.ts` (delete lines 18-57 and 156-216, replace the loop with one call)
- Test: `apps/desktop/src/main/import/markdown/markdown-importer.test.ts` (existing — must stay green, no edits expected)

**Interfaces:**

- Consumes: `ImportContext` from `../types`.
- Produces:

  ```ts
  function resolveCoLocatedAssets(args: {
    body: string
    noteId: string
    noteAbsPath: string
    rootDir: string
    ctx: ImportContext
    realRoots: Map<string, string>
  }): Promise<string>
  ```

  Returns the body with every resolvable asset reference replaced by attachment markdown. Reports each saved asset via `ctx.reportAttachment()` and each unresolvable one via `ctx.reportSkipped(...)`. `realRoots` is a caller-owned cache so one `realpath` is done per selection root, not per note.

- [ ] **Step 1: Run the existing markdown importer tests to capture the green baseline**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main markdown-importer
```

Expected: PASS. Record the test count — it must be identical after the move.

- [ ] **Step 2: Create the shared module**

Create `apps/desktop/src/main/import/_shared/co-located-assets.ts` by moving `escapeRegExp`, `replaceAssetToken`, `resolveRealRoot` and the asset loop out of `markdown-importer.ts` **verbatim** — same comments, same guard order:

```ts
/**
 * Co-located asset resolution shared by the folder-shaped importers.
 *
 * An export keeps its media next to (or above) the notes that reference it.
 * This resolves each reference against the note's own folder, refuses anything
 * that escapes the folder the user actually selected, saves what is left as a
 * vault attachment, and rewrites the reference to point at it.
 *
 * @module import/_shared/co-located-assets
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { saveAttachment } from '../../vault/attachments'
import { extractAssetRefs } from '@memry/importers/markdown'
import { attachmentMarkdown } from './attachment-markdown'
import { percentDecodeRef } from './html-to-markdown'
import type { ImportContext } from '../types'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace every token pointing at `ref` with the already-built attachment
 * markdown, dropping whatever alt/link text the source authored. Mirrors
 * `extractAssetRefs`' token shapes — markdown `![alt](ref)` / `[text](ref)` and
 * Obsidian's `![[ref]]` embed — so images and non-image file blocks both swap
 * cleanly regardless of label.
 */
function replaceAssetToken(body: string, ref: string, replacement: string): string {
  const escaped = escapeRegExp(ref)
  const tokenRe = new RegExp(`!?\\[[^\\][]*\\]\\(${escaped}\\)`, 'g')
  // Obsidian carries the target inside the brackets, optionally followed by a
  // display size / alias (`|300x200`) or an anchor (`#page=3`); the whole embed
  // goes, tail included, since the attachment markdown cannot express either.
  const embedRe = new RegExp(`!\\[\\[${escaped}(?:[|#][^\\][]*)?\\]\\]`, 'g')
  // Function replacer so `$` in the attachment markdown (e.g. a filename) is not
  // treated as a `String.replace` substitution pattern.
  return body.replace(tokenRe, () => replacement).replace(embedRe, () => replacement)
}

/**
 * Real path of a selected root, memoised. Falls back to the literal path when
 * it cannot be resolved — the boundary check then behaves as it did before,
 * rather than dropping every asset under that root.
 */
async function resolveRealRoot(rootDir: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(rootDir)
  if (cached !== undefined) return cached
  let real = rootDir
  try {
    real = await fs.realpath(rootDir)
  } catch {
    // keep the literal path
  }
  cache.set(rootDir, real)
  return real
}

export interface CoLocatedAssetArgs {
  body: string
  /** Pre-generated note id — attachments are saved under it before the note exists. */
  noteId: string
  noteAbsPath: string
  /** The folder the user selected; assets may not resolve outside it. */
  rootDir: string
  ctx: ImportContext
  /** Caller-owned `realpath` cache, one entry per selection root. */
  realRoots: Map<string, string>
}

export async function resolveCoLocatedAssets(args: CoLocatedAssetArgs): Promise<string> {
  const { body, noteId, noteAbsPath, rootDir, ctx, realRoots } = args

  const refs = extractAssetRefs(body)
  const sourceDir = path.dirname(noteAbsPath)
  const realRoot = await resolveRealRoot(rootDir, realRoots)

  let rewritten = body
  for (const ref of refs) {
    if (ctx.isCancelled()) break

    // Refs in markdown are commonly URL-encoded (e.g. `My%20File.png`);
    // decode for disk resolution while keeping the original `ref` to rewrite
    // the body link. `../` is preserved so the traversal guard stays meaningful.
    const decodedRef = percentDecodeRef(ref)
    // Refs are relative to the note, but the boundary is the folder the
    // user selected — exports routinely keep media in a sibling folder
    // (`../Images/Media/x.png`), which is still inside what they granted.
    const absRef = path.resolve(sourceDir, decodedRef)
    // A symlink inside the selection can point anywhere, and a string
    // compare would still read it as in-bounds while `readFile` walks
    // straight out of the folder — so resolve the ref for real first.
    // ENOENT here is a missing (or dangling) asset, same skip as a failed
    // read. `realRoot` is resolved the same way for a like-for-like
    // compare: macOS hands back `/private/var` for a `/var` path.
    let realRef: string
    try {
      realRef = await fs.realpath(absRef)
    } catch {
      ctx.reportSkipped(ref, 'Asset file not found')
      continue
    }
    const refRelToRoot = path.relative(realRoot, realRef)
    // Only a whole `..` segment escapes the root — a folder named `..img`
    // yields `..img/x.png`, which is inside it. `path.relative` also
    // returns an absolute path when the two sides live on different
    // Windows drives, so check that too.
    const escapesRoot = refRelToRoot === '..' || refRelToRoot.startsWith(`..${path.sep}`)
    if (escapesRoot || path.isAbsolute(refRelToRoot)) {
      ctx.reportSkipped(ref, 'Path traversal outside selected folder')
      continue
    }

    let bytes: Buffer
    try {
      bytes = await fs.readFile(realRef)
    } catch {
      ctx.reportSkipped(ref, 'Asset file not found')
      continue
    }

    const result = await saveAttachment(noteId, bytes, path.basename(decodedRef))
    // Images embed inline (url-encoded so spaces don't break `![](...)`);
    // other files become a clickable file block. Replaces the whole
    // `![alt](ref)` / `[text](ref)` token, not just the `](ref)` tail.
    const md = attachmentMarkdown(result)
    if (md) {
      rewritten = replaceAssetToken(rewritten, ref, md)
      ctx.reportAttachment()
    } else {
      ctx.reportSkipped(path.basename(decodedRef), result.error)
    }
  }

  return rewritten
}
```

- [ ] **Step 3: Switch the markdown importer over**

In `apps/desktop/src/main/import/markdown/markdown-importer.ts`:

1. Delete `escapeRegExp`, `replaceAssetToken` and `resolveRealRoot` (lines 18-57).
2. Drop the now-unused imports: `saveAttachment`, `attachmentMarkdown`, `extractAssetRefs`, `percentDecodeRef`. Keep `parseFrontmatter`, `mapFiles` and `FileDescriptor`.
3. Add `import { resolveCoLocatedAssets } from '../_shared/co-located-assets'`.
4. Replace the whole asset block (`const refs = extractAssetRefs(body)` down to the end of the `for (const ref of refs)` loop) with:

```ts
const rewritten = await resolveCoLocatedAssets({
  body,
  noteId,
  noteAbsPath: notePlan.absPath,
  rootDir: notePlan.rootDir,
  ctx,
  realRoots
})
```

The surrounding `createNote({ ..., content: rewritten, ... })` call is unchanged.

- [ ] **Step 4: Run the markdown importer tests to verify no regression**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main markdown-importer
pnpm typecheck
```

Expected: PASS, same test count as Step 1. The `nested-assets` and `wiki-embeds` cases are what prove the traversal guard and token rewriting moved intact.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/_shared/co-located-assets.ts apps/desktop/src/main/import/markdown/markdown-importer.ts
git commit -m "refactor(import): extract co-located asset resolution into _shared"
```

---

## Task 6: Extract the journal create helper

The journal create pipeline is inlined inside `ipc/journal-handlers.ts` and reachable only from IPC. No importer can write a journal entry today. Extract it once.

**Files:**

- Create: `apps/desktop/src/main/journal/create-entry.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts` (the `CREATE_ENTRY` handler, lines ~107-155, and the create branch inside `UPDATE_ENTRY`, lines ~171-207)
- Test: `apps/desktop/src/main/journal/create-entry.test.ts`

**Interfaces:**

- Consumes: existing `vault/journal`, `vault/journal-cache-sync`, `projections`, `journal/runtime-effects` modules.
- Produces:

  ```ts
  function createJournalEntry(input: {
    date: string
    content: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry>
  ```

  `JournalEntry` is the existing type from `@memry/contracts/journal-api`. The helper writes the file, syncs the cache, flushes projections, enqueues the sync create, initialises the CRDT doc and broadcasts `JournalChannels.events.ENTRY_CREATED` — exactly what the IPC handler does today, minus telemetry (which stays in the handler, since it records a user action).

  Also produces `function resolveJournalEntryId(date: string): string` — the canonical → cache → `generateJournalId(date)` fallback chain, exported so a caller can know the entry's id **before** creating it. Task 7 needs this: tasks parsed out of a daily note are created with `sourceNoteId` set, and that id must be the one the journal entry actually ends up with, not a freshly generated one.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/journal/create-entry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const broadcast = vi.fn()
const enqueueCreate = vi.fn()
const initCrdt = vi.fn().mockResolvedValue(undefined)
const syncCache = vi.fn()
const flush = vi.fn().mockResolvedValue(undefined)

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: broadcast }))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}), getDatabase: () => ({}) }))
vi.mock('../vault/journal', () => ({
  writeJournalEntryWithContent: vi.fn(async (date: string, content: string, tags?: string[]) => ({
    entry: {
      id: `journal-${date}`,
      date,
      content,
      wordCount: 1,
      characterCount: content.length,
      tags: tags ?? [],
      createdAt: '2026-08-12T00:00:00.000Z',
      modifiedAt: '2026-08-12T00:00:00.000Z'
    },
    fileContent: content,
    frontmatter: { date }
  })),
  getJournalRelativePath: (date: string) => `journal/${date}.md`
}))
vi.mock('../vault/journal-cache-sync', () => ({ syncJournalCache: syncCache }))
vi.mock('../projections', () => ({ flushProjectionEvents: flush }))
vi.mock('./runtime-effects', () => ({
  enqueueJournalCreate: enqueueCreate,
  initializeJournalCrdt: initCrdt
}))
vi.mock('@memry/domain-notes', () => ({ getCanonicalJournalByDate: () => undefined }))
// create-entry.ts imports both of these from './store'.
vi.mock('./store', () => ({
  getJournalEntryByDate: () => undefined,
  getNoteCacheByPath: () => undefined
}))

import { generateJournalId } from '@memry/contracts/journal-api'
import { createJournalEntry, resolveJournalEntryId } from './create-entry'

const DATE = '2026-08-12'

describe('resolveJournalEntryId', () => {
  it('falls back to the deterministic id when nothing is cached', () => {
    expect(resolveJournalEntryId(DATE)).toBe(generateJournalId(DATE))
  })
})

describe('createJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the entry and runs the full create pipeline', async () => {
    const entry = await createJournalEntry({ date: DATE, content: 'hello' })
    const id = generateJournalId(DATE)

    expect(entry.date).toBe(DATE)
    expect(entry.content).toBe('hello')
    // The entry carries the resolved id, not whatever the file write returned.
    expect(entry.id).toBe(id)
    expect(syncCache).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(enqueueCreate).toHaveBeenCalledWith(id, DATE)
    expect(initCrdt).toHaveBeenCalledWith(id, DATE, [])
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('marks the cache write as new when no cache row exists', async () => {
    await createJournalEntry({ date: DATE, content: 'hello' })
    expect(syncCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: `journal/${DATE}.md`, title: DATE }),
      { isNew: true }
    )
  })

  it('uses the same id createJournalEntry will settle on', async () => {
    const predicted = resolveJournalEntryId(DATE)
    const entry = await createJournalEntry({ date: DATE, content: 'hello' })
    expect(entry.id).toBe(predicted)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main journal/create-entry
```

Expected: FAIL — cannot resolve `./create-entry`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/journal/create-entry.ts`, moving the body of the `CREATE_ENTRY` handler over unchanged:

```ts
/**
 * Create a journal entry, end to end.
 *
 * Writing a journal entry is more than a file write: the index cache has to
 * learn about it, projections have to flush, the sync queue and the CRDT doc
 * have to be seeded, and open windows have to be told. That sequence used to
 * live inline inside the IPC handlers, which made it unreachable from
 * anywhere else — importers included. It lives here now, and the handlers
 * call it.
 *
 * @module journal/create-entry
 */

import { JournalChannels } from '@memry/contracts/ipc-channels'
import { generateJournalId, type JournalEntry } from '@memry/contracts/journal-api'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getDatabase, getIndexDatabase } from '../database'
import { writeJournalEntryWithContent, getJournalRelativePath } from '../vault/journal'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { flushProjectionEvents } from '../projections'
import { enqueueJournalCreate, initializeJournalCrdt } from './runtime-effects'
import { getJournalEntryByDate, getNoteCacheByPath } from './store'

export interface CreateJournalEntryInput {
  /** ISO `YYYY-MM-DD`. */
  date: string
  content: string
  tags?: string[]
  properties?: Record<string, unknown>
}

/**
 * The id a journal entry for `date` has (or will have): the canonical row in
 * data.db wins, then the index cache, then the deterministic id derived from
 * the date. Exported so a caller that needs the id *before* the entry exists —
 * an importer creating tasks with `sourceNoteId` — gets the same one the
 * create path will settle on.
 */
export function resolveJournalEntryId(date: string): string {
  const db = getIndexDatabase()
  const dataDb = getDatabase()
  const journalPath = getJournalRelativePath(date)
  const cached = getJournalEntryByDate(db, date) ?? getNoteCacheByPath(db, journalPath)
  const canonical = getCanonicalJournalByDate(dataDb, date)
  return canonical?.id ?? cached?.id ?? generateJournalId(date)
}

export async function createJournalEntry(input: CreateJournalEntryInput): Promise<JournalEntry> {
  const db = getIndexDatabase()
  const journalPath = getJournalRelativePath(input.date)
  // Read the cache row before the write, so `isNew` reflects whether the entry
  // existed beforehand rather than what the write just produced.
  const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
  const cacheId = resolveJournalEntryId(input.date)

  const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
    input.date,
    input.content,
    input.tags,
    null,
    input.properties
  )

  syncJournalCache(
    db,
    {
      id: cacheId,
      path: journalPath,
      fileContent,
      frontmatter,
      parsedContent: entry.content,
      title: entry.date,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    },
    { isNew: !cached }
  )
  await flushProjectionEvents()

  const syncedEntry = cacheId === entry.id ? entry : { ...entry, id: cacheId }
  enqueueJournalCreate(cacheId, syncedEntry.date)
  await initializeJournalCrdt(cacheId, syncedEntry.date, syncedEntry.tags)

  broadcastToAllWindows(JournalChannels.events.ENTRY_CREATED, {
    date: syncedEntry.date,
    entry: syncedEntry
  })

  return syncedEntry
}
```

- [ ] **Step 4: Switch the IPC handlers over**

In `apps/desktop/src/main/ipc/journal-handlers.ts`:

1. Add `import { createJournalEntry } from '../journal/create-entry'`.
2. Replace the `CREATE_ENTRY` handler body with:

```ts
createValidatedHandler(CreateEntryInputSchema, async (input): Promise<JournalEntry> => {
  return createJournalEntry({
    date: input.date,
    content: input.content ?? '',
    tags: input.tags,
    properties: input.properties
  })
})
```

3. Replace the `if (!existing)` create branch inside `UPDATE_ENTRY` with:

```ts
if (!existing) {
  return createJournalEntry({
    date: input.date,
    content: input.content ?? '',
    tags: input.tags ?? [],
    properties: input.properties
  })
}
```

4. Remove any import that is now unused (check `getCanonicalJournalByDate`, `enqueueJournalCreate`, `initializeJournalCrdt`, `getNoteCacheByPath`, `flushProjectionEvents` — several are still used by the update/delete handlers; only remove what the compiler flags).

- [ ] **Step 5: Run the journal tests**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main journal
pnpm typecheck
```

Expected: PASS. `journal-handlers.test.ts` must stay green — it already mocks `journal/runtime-effects` and `sync/crdt-provider`, so the extracted helper runs against the same fakes.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/journal/create-entry.ts apps/desktop/src/main/journal/create-entry.test.ts apps/desktop/src/main/ipc/journal-handlers.ts
git commit -m "refactor(journal): extract the entry create pipeline out of the IPC handler"
```

---

## Task 7: The orchestrator

**Files:**

- Create: `apps/desktop/src/main/import/noteplan/noteplan-importer.ts`
- Create: `apps/desktop/src/main/import/noteplan/__fixtures__/sample/Calendar/20260812.txt`
- Create: `apps/desktop/src/main/import/noteplan/__fixtures__/sample/Calendar/2026-W33.txt`
- Create: `apps/desktop/src/main/import/noteplan/__fixtures__/sample/Notes/start-here.txt`
- Create: `apps/desktop/src/main/import/noteplan/__fixtures__/sample/Notes/10 - Projects/project-sample-1.txt`
- Create: `apps/desktop/src/main/import/noteplan/__fixtures__/sample/Filters/All Tasks`
- Test: `apps/desktop/src/main/import/noteplan/noteplan-importer.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-6.
- Produces:

  ```ts
  interface NotePlanTaskDeps {
    createTask(a: {
      projectId: string
      title: string
      dueDate: string | null
      parentId: string | null
      sourceNoteId: string
    }): Promise<{ success: boolean; task?: { id: string } | null }>
    completeTask(a: { id: string; completedAt?: string }): Promise<unknown>
    archiveTask(id: string): Promise<unknown>
    getInboxProjectId(): string | undefined
  }
  function runNotePlanImport(
    input: ImportInput,
    ctx: ImportContext,
    deps?: NotePlanTaskDeps
  ): Promise<ImportSummary>
  const notePlanImporter: Importer // id: 'noteplan'
  ```

  `deps` is injectable so the integration test drives the task side with fakes (the TickTick importer uses the same pattern) while the vault and journal writes stay real.

- [ ] **Step 1: Write the fixtures**

`__fixtures__/sample/Calendar/20260812.txt`:

```
Here's your first task:
* Watch the getting-started video >2026-08-13
* [x] Read the manual @done(2026-08-12)
* [-] Abandoned idea

## Today's Plan
+ 08:00 - 09:00 Reply to emails
+ [x] Gym

- Websites to read later
See also [[Start Here]].
```

`__fixtures__/sample/Calendar/2026-W33.txt`:

```
# Week 33 review
- shipped the importer
```

`__fixtures__/sample/Notes/start-here.txt`:

```
---
type: guide
icon: hand-point-right
bg-color: blue-50
---
# Start Here
Some guidance. Tagged #guides/onboarding.
```

`__fixtures__/sample/Notes/10 - Projects/project-sample-1.txt`:

```
---
type: area
status: Active
owner: Web
icon: truck
icon-color: purple-600
---
# Project Aurora: Website Redesign

## Tasks
* Project kickoff >2025-11-03
	* Confirm stakeholders
	+ Agenda shared
* Measurement setup
```

`__fixtures__/sample/Filters/All Tasks` — any short binary-ish content, e.g. the literal text `bplist00` (it must simply exist and be extension-less so the scanner proves it is ignored).

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/import/noteplan/noteplan-importer.test.ts`:

```ts
/**
 * Integration test for the NotePlan importer orchestrator.
 * Runs against a fixture export and a real temp vault + databases; the task
 * side is driven through injected fakes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import type { NotePlanTaskDeps } from './noteplan-importer'

vi.mock('electron', () => {
  const send = vi.fn()
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }])
    },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

vi.mock('../../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  initializeJournalCrdt: vi.fn().mockResolvedValue(undefined)
}))

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'sample')

interface FakeTask {
  id: string
  title: string
  dueDate: string | null
  parentId: string | null
  completed: boolean
  archived: boolean
}

function makeDeps(): { deps: NotePlanTaskDeps; tasks: FakeTask[] } {
  const tasks: FakeTask[] = []
  let n = 0
  const deps: NotePlanTaskDeps = {
    async createTask(a) {
      const id = `task-${n++}`
      tasks.push({
        id,
        title: a.title,
        dueDate: a.dueDate,
        parentId: a.parentId,
        completed: false,
        archived: false
      })
      return { success: true, task: { id } }
    },
    async completeTask(a) {
      const t = tasks.find((x) => x.id === a.id)
      if (t) t.completed = true
      return {}
    },
    async archiveTask(id) {
      const t = tasks.find((x) => x.id === id)
      if (t) t.archived = true
      return {}
    },
    getInboxProjectId: () => 'inbox-1'
  }
  return { deps, tasks }
}

describe('notePlanImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./noteplan-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('noteplan-import-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()

    vaultIndex = await import('../../vault/index')
    database = await import('../../database')

    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./noteplan-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('writes a daily calendar file as a journal entry', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np1', new AbortController().signal)
    const summary = await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    expect(summary.failed).toEqual([])

    const journalFile = path.join(tempVault.path, 'journal', '2026-08-12.md')
    expect(fs.existsSync(journalFile)).toBe(true)
    const journal = fs.readFileSync(journalFile, 'utf8')
    expect(journal).toContain('date: 2026-08-12')
    // Tasks became checkboxes carrying a real task id.
    expect(journal).toMatch(/- \[ \] Watch the getting-started video \{task:task-\d+\}/)
    // Checklists became plain checkboxes with no task id.
    expect(journal).toContain('- [ ] 08:00 - 09:00 Reply to emails')
    expect(journal).not.toMatch(/Reply to emails \{task:/)
    // Bullets stayed bullets, wikilinks untouched.
    expect(journal).toContain('- Websites to read later')
    expect(journal).toContain('[[Start Here]]')
  })

  it('creates task rows with due dates, completion and cancellation', async () => {
    const { deps, tasks } = makeDeps()
    const ctx = importContext.createImportContext('np2', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const video = tasks.find((t) => t.title === 'Watch the getting-started video')
    expect(video?.dueDate).toBe('2026-08-13')

    const manual = tasks.find((t) => t.title === 'Read the manual')
    expect(manual?.completed).toBe(true)

    const abandoned = tasks.find((t) => t.title === 'Abandoned idea')
    expect(abandoned?.archived).toBe(true)

    // Checklists never become task rows.
    expect(tasks.some((t) => t.title.includes('Reply to emails'))).toBe(false)
    expect(tasks.some((t) => t.title === 'Gym')).toBe(false)
  })

  it('links a nested task to its parent', async () => {
    const { deps, tasks } = makeDeps()
    const ctx = importContext.createImportContext('np3', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const kickoff = tasks.find((t) => t.title === 'Project kickoff')
    const child = tasks.find((t) => t.title === 'Confirm stakeholders')
    expect(kickoff).toBeDefined()
    expect(child?.parentId).toBe(kickoff?.id)
    expect(kickoff?.dueDate).toBe('2025-11-03')
  })

  it('titles notes from their H1 and mirrors the folder tree', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np4', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    // start-here.txt has `# Start Here` — the title must come from the H1, not
    // the filename, or `[[Start Here]]` will not resolve.
    expect(fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'Start Here.md'))).toBe(true)

    const project = path.join(
      tempVault.notesDir,
      'NotePlan',
      '10 - Projects',
      'Project Aurora: Website Redesign.md'
    )
    expect(fs.existsSync(project)).toBe(true)

    // Weekly files have no journal equivalent — they land as notes.
    expect(
      fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'Calendar', 'Week 33 review.md'))
    ).toBe(true)
  })

  it('keeps semantic frontmatter and drops NotePlan styling keys', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np5', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const project = fs.readFileSync(
      path.join(
        tempVault.notesDir,
        'NotePlan',
        '10 - Projects',
        'Project Aurora: Website Redesign.md'
      ),
      'utf8'
    )
    expect(project).toContain('status')
    expect(project).toContain('Active')
    expect(project).not.toContain('icon-color')
    expect(project).not.toContain('purple-600')
  })

  it('ignores the Filters folder entirely', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np6', new AbortController().signal)
    const summary = await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    // 2 notes + 1 weekly note + 1 journal entry = 4; nothing from Filters/.
    expect(summary.imported).toBe(4)
    expect(summary.failed).toEqual([])
    expect(fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'All Tasks.md'))).toBe(false)
  })

  it('appends to an existing journal entry instead of overwriting it', async () => {
    fs.writeFileSync(
      path.join(tempVault.path, 'journal', '2026-08-12.md'),
      '---\ndate: 2026-08-12\n---\nMy own words.',
      'utf8'
    )

    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np7', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const journal = fs.readFileSync(path.join(tempVault.path, 'journal', '2026-08-12.md'), 'utf8')
    expect(journal).toContain('My own words.')
    expect(journal).toContain('## Imported from NotePlan')
    expect(journal).toContain('Watch the getting-started video')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main noteplan-importer
```

Expected: FAIL — cannot resolve `./noteplan-importer`.

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/src/main/import/noteplan/noteplan-importer.ts`:

```ts
/**
 * NotePlan 3 importer (orchestrator).
 *
 * Input is a NotePlan data folder (or one of its `Backups/<stamp>` copies,
 * which have the same shape). The pure `@memry/importers/noteplan` package
 * does all the parsing; this module does IO only:
 *
 *   Calendar/YYYYMMDD.txt        → a real Memry journal entry
 *   Calendar/YYYY-Wnn|MM|Qn|YYYY → notes under NotePlan/Calendar
 *   Notes/**                     → notes under NotePlan/<original tree>
 *   @Archive/**                  → notes under NotePlan/Archive
 *
 * NotePlan tasks (`*` lines) become real Memry task rows in the Inbox
 * project, linked back to the note they came from via `sourceNoteId`, and
 * embedded in the body as `- [ ] Title {task:<id>}`.
 *
 * @module import/noteplan/noteplan-importer
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import matter from 'gray-matter'
import { createNote } from '../../vault/notes-crud'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import {
  convertBody,
  firstHeading,
  mapFiles,
  mapProperties,
  parseTags,
  stripFirstHeading,
  taskPlaceholder
} from '@memry/importers/noteplan'
import type { ParsedTask, ScannedFile } from '@memry/importers/noteplan'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { resolveCoLocatedAssets } from '../_shared/co-located-assets'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'

const logger = createLogger('NotePlanImport')

/** Directories NotePlan owns that hold nothing importable. */
const IGNORED_DIRS = new Set(['Filters', '@Trash', 'Plugins', 'Caches', '.git'])

/** Where the macOS app keeps its data, relative to the user's home. */
const MACOS_CONTAINER_REL =
  'Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3'

/**
 * Absolute path the folder picker opens at. `defaultPath` reaches
 * `dialog.showOpenDialog` verbatim, so it must be absolute — same shape as the
 * Apple Notes importer's `defaultContainerDir()`.
 */
function defaultContainerDir(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  return path.join(os.homedir(), MACOS_CONTAINER_REL)
}

/** Injected task-side effects, so the orchestration is testable without the DB. */
export interface NotePlanTaskDeps {
  createTask(a: {
    projectId: string
    title: string
    dueDate: string | null
    parentId: string | null
    sourceNoteId: string
  }): Promise<{ success: boolean; task?: { id: string } | null }>
  completeTask(a: { id: string; completedAt?: string }): Promise<unknown>
  archiveTask(id: string): Promise<unknown>
  getInboxProjectId(): string | undefined
}

/** Build the real (db-backed) task deps lazily so importing this module stays light. */
async function defaultTaskDeps(): Promise<NotePlanTaskDeps> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  const { getInboxProject } = await import('@main/database/queries/projects')

  const db = requireDatabase()
  const domain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  return {
    createTask: (a) =>
      domain.createTask({
        projectId: a.projectId,
        title: a.title,
        dueDate: a.dueDate,
        parentId: a.parentId,
        sourceNoteId: a.sourceNoteId
      }),
    completeTask: (a) => domain.completeTask(a),
    archiveTask: (id) => domain.archiveTask(id),
    getInboxProjectId: () => getInboxProject(db)?.id
  }
}

/** Walk one area directory, collecting every file under it. */
async function collectArea(
  dir: string,
  areaRoot: string,
  rootDir: string,
  area: ScannedFile['area'],
  out: ScannedFile[]
): Promise<void> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectArea(absPath, areaRoot, rootDir, area, out)
    } else if (entry.isFile()) {
      if (entry.name === '.DS_Store') continue
      out.push({ relPath: path.relative(areaRoot, absPath), absPath, rootDir, area })
    }
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Find the importable areas under a selected folder. Accepts the NotePlan data
 * root, a `Backups/<stamp>` copy (same shape), or a bare `Notes` folder.
 */
async function scanSource(sourcePath: string, out: ScannedFile[]): Promise<void> {
  const areas: { dir: string; area: ScannedFile['area'] }[] = [
    { dir: path.join(sourcePath, 'Calendar'), area: 'calendar' },
    { dir: path.join(sourcePath, 'Notes'), area: 'notes' },
    { dir: path.join(sourcePath, '@Archive'), area: 'archive' }
  ]

  let matched = false
  for (const { dir, area } of areas) {
    if (await isDirectory(dir)) {
      matched = true
      await collectArea(dir, dir, sourcePath, area, out)
    }
  }

  // The user pointed straight at a notes folder — treat the whole selection
  // as the notes area.
  if (!matched) await collectArea(sourcePath, sourcePath, sourcePath, 'notes', out)
}

/**
 * Create a task row per parsed task and return the placeholder → `{task:id}`
 * substitutions. Tasks whose row could not be created lose their placeholder
 * (the checkbox stays, the id suffix does not) rather than leaving a dangling
 * `{np-task:…}` in the body.
 */
async function createTasks(
  tasks: ParsedTask[],
  noteId: string,
  projectId: string,
  deps: NotePlanTaskDeps,
  ctx: ImportContext
): Promise<Map<string, string>> {
  const realIds = new Map<string, string>()

  for (const task of tasks) {
    if (ctx.isCancelled()) break
    if (!task.title) {
      ctx.reportSkipped(task.tempId, 'Task has no title')
      continue
    }

    const parentId = task.parentTempId ? (realIds.get(task.parentTempId) ?? null) : null

    let created: Awaited<ReturnType<NotePlanTaskDeps['createTask']>>
    try {
      created = await deps.createTask({
        projectId,
        title: task.title,
        dueDate: task.dueDate,
        parentId,
        sourceNoteId: noteId
      })
    } catch (error) {
      ctx.reportFailed(task.title, error)
      continue
    }

    const id = created.task?.id
    if (!created.success || !id) {
      ctx.reportFailed(task.title, 'Task could not be created')
      continue
    }

    realIds.set(task.tempId, id)

    if (task.state === 'done') {
      await deps.completeTask({ id, completedAt: task.completedAt ?? undefined })
    } else if (task.state === 'cancelled') {
      // Memry has no cancelled state; archiving is what the TickTick importer
      // does with the same concept.
      await deps.archiveTask(id)
    }
  }

  return realIds
}

/**
 * Swap every `{np-task:<tempId>}` placeholder for the real `{task:<id>}`
 * suffix. A tempId with no row (creation failed, or an empty title) has its
 * placeholder removed so the line stays a valid plain checkbox.
 */
function applyTaskIds(markdown: string, tasks: ParsedTask[], realIds: Map<string, string>): string {
  let out = markdown
  for (const task of tasks) {
    const placeholder = taskPlaceholder(task.tempId)
    const id = realIds.get(task.tempId)
    if (id) {
      // The `{task:<id>}` suffix is the shape `parseTaskBlockSuffix` and
      // `scanTaskCheckboxStates` in `@memry/shared/task-block` read back.
      out = out.split(placeholder).join(`{task:${id}}`)
    } else {
      // No row: drop the placeholder (and the space before it) so the line
      // stays a valid plain checkbox rather than leaking `{np-task:…}`.
      out = out.split(` ${placeholder}`).join('').split(placeholder).join('')
    }
  }
  return out
}

interface PreparedBody {
  title: string
  markdown: string
  tags: string[]
  properties: Record<string, unknown>
  tasks: ParsedTask[]
}

/** Frontmatter `tags` may be a list or a single string. */
function frontmatterTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

async function prepare(absPath: string, fallbackTitle: string): Promise<PreparedBody> {
  const raw = await fs.readFile(absPath, 'utf8')
  const { data, content } = matter(raw)
  const frontmatter = data as Record<string, unknown>
  // `tags` is a first-class note field in Memry, not a property — lift it out
  // before mapping the rest, or it lands in the properties panel instead.
  const declaredTags = frontmatterTags(frontmatter.tags)
  const { tags: _ignored, ...rest } = frontmatter
  const { properties } = mapProperties(rest)

  const heading = firstHeading(content)
  // The H1 is NotePlan's real title; it moves onto the note, so drop that one
  // line from the body rather than rendering the title twice.
  const body = heading ? stripFirstHeading(content) : content

  const converted = convertBody(body)

  return {
    title: heading ?? fallbackTitle,
    markdown: converted.markdown,
    tags: [...new Set([...declaredTags, ...parseTags(body)])].sort(),
    properties,
    tasks: converted.tasks
  }
}

export async function runNotePlanImport(
  input: ImportInput,
  ctx: ImportContext,
  injected?: NotePlanTaskDeps
): Promise<ImportSummary> {
  const deps = injected ?? (await defaultTaskDeps())

  // ---- Phase 1: scan ----
  ctx.setPhase('scanning')
  ctx.status(IMPORT_STATUS.notePlanScanning)

  const scanned: ScannedFile[] = []
  for (const sourcePath of input.sourcePaths) {
    if (ctx.isCancelled()) return ctx.toSummary()
    await scanSource(sourcePath, scanned)
  }

  const plan = mapFiles(scanned)
  for (const skip of plan.skipped) ctx.reportSkipped(skip.item, skip.reason)

  const total = plan.notes.length + plan.journals.length
  ctx.reportProgress(0, total)
  if (ctx.isCancelled()) return ctx.toSummary()

  // ---- Phase 2: write ----
  ctx.setPhase('importing')
  const projectId = deps.getInboxProjectId()
  if (!projectId) {
    // Every task needs a project. Without an Inbox the notes still import, but
    // their tasks stay as plain checkboxes — say so rather than dropping them
    // silently.
    logger.warn('no inbox project — NotePlan tasks will import as plain checkboxes')
    ctx.reportSkipped('Tasks', 'No Inbox project to import tasks into')
  }
  const realRoots = new Map<string, string>()
  let done = 0

  for (const planned of plan.notes) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      const prepared = await prepare(planned.absPath, planned.title)
      ctx.status(importingItemStatus(prepared.title))

      const noteId = generateNoteId()
      let markdown = await resolveCoLocatedAssets({
        body: prepared.markdown,
        noteId,
        noteAbsPath: planned.absPath,
        rootDir: planned.rootDir,
        ctx,
        realRoots
      })

      if (projectId) {
        const realIds = await createTasks(prepared.tasks, noteId, projectId, deps, ctx)
        markdown = applyTaskIds(markdown, prepared.tasks, realIds)
      } else {
        markdown = applyTaskIds(markdown, prepared.tasks, new Map())
      }

      const stat = await fs.stat(planned.absPath)
      await createNote({
        id: noteId,
        title: prepared.title,
        content: markdown,
        folder: planned.vaultFolder,
        tags: prepared.tags,
        properties: prepared.properties,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString()
      })
      ctx.reportImported()
    } catch (error) {
      logger.warn('noteplan note import failed', { absPath: planned.absPath })
      ctx.reportFailed(planned.absPath, error)
    }
    done++
    ctx.reportProgress(done, total)
  }

  const { createJournalEntry, resolveJournalEntryId } = await import('../../journal/create-entry')
  const { readJournalEntry } = await import('../../vault/journal')

  for (const planned of plan.journals) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      const prepared = await prepare(planned.absPath, planned.date)
      ctx.status(importingItemStatus(planned.date))

      // A journal entry is user-authored: never overwrite one that already has
      // content. Append below a rule instead.
      const existing = await readJournalEntry(planned.date)
      // Must be the id the entry will actually settle on — tasks are created
      // with it as `sourceNoteId` before the entry is written.
      const noteId = resolveJournalEntryId(planned.date)

      let markdown = await resolveCoLocatedAssets({
        body: prepared.markdown,
        noteId,
        noteAbsPath: planned.absPath,
        rootDir: planned.rootDir,
        ctx,
        realRoots
      })

      if (projectId) {
        const realIds = await createTasks(prepared.tasks, noteId, projectId, deps, ctx)
        markdown = applyTaskIds(markdown, prepared.tasks, realIds)
      } else {
        markdown = applyTaskIds(markdown, prepared.tasks, new Map())
      }

      const content =
        existing && existing.content.trim().length > 0
          ? `${existing.content.trim()}\n\n## Imported from NotePlan\n\n${markdown}`
          : markdown

      await createJournalEntry({
        date: planned.date,
        content,
        tags: [...new Set([...(existing?.tags ?? []), ...prepared.tags])]
      })
      ctx.reportImported()
    } catch (error) {
      logger.warn('noteplan journal import failed', { absPath: planned.absPath })
      ctx.reportFailed(planned.absPath, error)
    }
    done++
    ctx.reportProgress(done, total)
  }

  ctx.setPhase('done')
  return ctx.toSummary()
}

export const notePlanImporter: Importer = {
  id: 'noteplan',
  name: 'NotePlan',
  descriptionKey: 'import.sources.noteplan',
  fileSpec: {
    label: 'NotePlan folder',
    extensions: [],
    allowMultiple: false,
    directory: true,
    defaultPath: defaultContainerDir(),
    message:
      'Select your NotePlan folder — either the app’s data folder or one of its Backups copies.'
  },
  run: (input, ctx) => runNotePlanImport(input, ctx)
}
```

This file also needs `import * as os from 'os'` alongside the `fs`/`path` imports.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main noteplan-importer
pnpm typecheck
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/import/noteplan/
git commit -m "feat(import): NotePlan importer orchestrator"
```

---

## Task 8: Register, translate and document

**Files:**

- Modify: `packages/importers/src/messages.ts`
- Modify: `apps/desktop/src/main/import/register-builtins.ts`
- Modify: `packages/i18n/src/locales/en/settings.json`
- Test: `apps/desktop/src/main/import/registry.test.ts` (existing — confirm it still passes)

**Interfaces:**

- Consumes: `notePlanImporter` (Task 7).
- Produces: `IMPORT_STATUS.notePlanScanning` (used in Task 7's Step 4 — this task makes it exist).

> If Task 7 was implemented first, `IMPORT_STATUS.notePlanScanning` will not typecheck until this step lands. Either do this step's message change before Task 7's Step 5, or accept one red typecheck between the two commits.

- [ ] **Step 1: Add the status code**

In `packages/importers/src/messages.ts`:

1. In `IMPORT_STATUS_CODES`, after `htmlScanning`, add:

```ts
  notePlanScanning: 'status.noteplan.scanning',
```

2. In the `IMPORT_STATUS` object, after `htmlScanning`, add:

```ts
  notePlanScanning: {
    code: IMPORT_STATUS_CODES.notePlanScanning,
    message: 'Scanning NotePlan folder…'
  },
```

The `satisfies Record<Exclude<keyof typeof IMPORT_STATUS_CODES, …>, ImportMessage>` constraint at the bottom of the file makes a missing English line a typecheck failure, so both edits are required together.

- [ ] **Step 2: Register the importer**

In `apps/desktop/src/main/import/register-builtins.ts`:

1. Add `import { notePlanImporter } from './noteplan/noteplan-importer'` after the `markdownImporter` import.
2. Add `registerImporter(notePlanImporter)` inside `registerBuiltinImporters`, after `registerImporter(markdownImporter)`.

- [ ] **Step 3: Add the translations**

In `packages/i18n/src/locales/en/settings.json`:

1. Under `import.sources`, after the `"markdown"` line, add:

```json
      "noteplan": "Import a NotePlan folder — daily notes become journal entries, tasks become tasks",
```

2. Under `import.messages.status`, alongside the other per-importer status objects, add:

```json
      "noteplan": {
        "scanning": "Scanning NotePlan folder…"
      },
```

Match the surrounding nesting exactly — open the file and place these next to the existing `roam` entries at both sites.

- [ ] **Step 4: Verify the whole surface**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared noteplan
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main import
pnpm --filter @memry/desktop i18n:check
pnpm typecheck
pnpm lint
```

Expected: all PASS. `registry.test.ts` asserts every registered importer has a `descriptionKey`; `i18n:check` confirms the English key exists.

- [ ] **Step 5: Commit**

```bash
git add packages/importers/src/messages.ts apps/desktop/src/main/import/register-builtins.ts packages/i18n/src/locales/en/settings.json
git commit -m "feat(import): register the NotePlan importer"
```

- [ ] **Step 6: Docs gate**

Desktop code changed, so the docs gate applies (see `CLAUDE.md` → Docs Automation):

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, add the NotePlan importer to the import documentation under `apps/docs/src/**` (find the page that lists the other importers and follow its structure), then re-run:

```bash
pnpm docs:impact --base origin/main --strict
pnpm docs:build
```

Commit any docs changes:

```bash
git add apps/docs/src
git commit -m "docs: document the NotePlan importer"
```

---

## Final verification

- [ ] Full test suite (~8 minutes — run it once, at the end, never inside a subagent):

```bash
pnpm test
```

- [ ] Manual smoke test in the running app:

```bash
pnpm dev
```

Settings → Import → NotePlan → choose
`~/Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3/Backups/2026-08-12 17-44-16`.
Confirm: notes appear under `NotePlan/` with their H1 titles, `[[Start Here]]` resolves, the 2026-08-12 journal entry exists, and tasks appear in the Inbox with the right due dates and completion states.

---

## Out of scope

Deliberately not built, per the design spec:

- `@Templates/` → Memry templates.
- NotePlan Filters / saved searches (binary plists).
- NotePlan priority markers (`!`, `!!`, `!!!`) → Memry task priority.
- Promoting inline `#tags` to per-note tag rows beyond frontmatter.
- Re-run deduplication — this is a one-time import, consistent with every other importer in the repo.
- NotePlan Spaces / team content.
