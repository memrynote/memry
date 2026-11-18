/**
 * Obsidian Tasks import vectors (Step 32g, #3549): runs `buildObsidianTaskImport`
 * (`@memry/shared/obsidian-task-import`) over a list of lines and over every line of the plugin's
 * own fixtures (`packages/shared/src/obsidian-tasks-fixtures`), and records what it returns. The
 * Rust port (`crates/memry-desktop/src/import/obsidian_tasks.rs`) replays the file in
 * `crates/memry-desktop/tests/obsidian_task_import.rs`.
 *
 * `completedAt` is the instant local midnight starts on the plugin's done date, so it depends on
 * the process time zone. This project runs in forks, where assigning `process.env.TZ` takes
 * effect: each line is built in fixed-offset zones on both sides of UTC, and done dates around
 * real midnight transitions (a skipped midnight, a repeated one, a skipped day) in their zones.
 *
 * `MEMRY_WRITE_VECTORS=1` rewrites the committed file; without it the test fails when it
 * differs. The vectors freeze when the TypeScript is deleted: fix the Rust, not the vector.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { buildObsidianTaskImport } from '@memry/shared/obsidian-task-import'
import { parseObsidianTaskLine } from '@memry/shared/obsidian-tasks'

const ROOT = path.resolve(__dirname, '../../../../../..')
const VECTOR_FILE = path.join(ROOT, 'packages/contracts/test-vectors/importers/obsidian-tasks.json')
const FIXTURES = path.join(ROOT, 'packages/shared/src/obsidian-tasks-fixtures')

const NOW = new Date('2026-03-04T09:30:00.000Z')

/** Each zone with the `getTimezoneOffset()` it must give, which proves the switch took. */
const ZONES: { zone: string; offset: number }[] = [
  { zone: 'UTC', offset: 0 },
  { zone: 'Etc/GMT+5', offset: 300 },
  { zone: 'Etc/GMT-14', offset: -840 }
]

const TEXTS = [
  // Nothing to import.
  '',
  'Buy milk',
  'Buy milk #errand',
  'Buy milk ^abc123',
  'Buy milk 🆔 abc123',
  'Buy milk ⛔ abc123',
  'Buy milk 📅 2026-01-01\r',
  'a :: b',
  // Priority.
  'Buy milk 🔺',
  'Buy milk ⏫',
  'Buy milk 🔼',
  'Buy milk 🔽',
  'Buy milk ⏬',
  'Buy milk ⏫\uFE0F',
  '⏫',
  'Buy milk [priority:: highest]',
  'Buy milk [priority:: lowest]',
  'Buy milk (priority:: medium)',
  'Buy milk [priority:: urgent]',
  // Dates.
  'Buy milk 📅 2026-01-01',
  'Buy milk 📆 2026-01-02',
  'Buy milk 🗓 2026-01-03',
  'Buy milk 🛫 2026-01-04',
  'Buy milk ⏳ 2026-01-05',
  'Buy milk ⌛ 2026-01-06',
  'Buy milk 🛫 2026-01-04 ⏳ 2026-01-05',
  'Buy milk ❌ 2026-01-08',
  'Buy milk ➕ 2026-01-09',
  'Buy milk [due:: 2026-01-01]',
  'Buy milk (scheduled:: 2026-01-05)',
  'Buy milk [start:: 2026-01-04] [scheduled:: 2026-01-05]',
  'Buy milk [due:: 2026-01-01)',
  'Buy milk 📅 2026-02-30',
  'Buy milk 📅 2026-13-45',
  // Done dates: valid, the calendar's edges, and dates the calendar does not have.
  'Buy milk ✅ 2026-01-07',
  'Buy milk [completion:: 2026-01-07]',
  'Buy milk ✅ 2024-02-29',
  'Buy milk ✅ 2025-02-29',
  'Buy milk ✅ 2026-02-30',
  'Buy milk ✅ 2026-13-01',
  'Buy milk ✅ 2026-00-10',
  'Buy milk ✅ 2026-01-00',
  'Buy milk ✅ 2026-01-32',
  'Buy milk ✅ 0026-01-01',
  'Buy milk ✅ 0099-12-31',
  'Buy milk ✅ 0100-01-01',
  'Buy milk ✅ 0999-06-15',
  'Buy milk ✅ 9999-12-31',
  'Buy milk ✅ 2026-12-31',
  'Buy milk 📅 2026-01-01 ✅ 2026-02-30',
  // Recurrence.
  'Buy milk 🔁 every day',
  'Buy milk 🔁 every week',
  'Buy milk 🔁 every 2 weeks',
  'Buy milk 🔁 every month',
  'Buy milk 🔁 every year',
  'Buy milk 🔁 every 3 days',
  'Buy milk 🔁 every 0 days',
  'Buy milk 🔁 every 99999999999999999 days',
  'Buy milk 🔁 every 123456789012345678901234567890 days',
  `Buy milk 🔁 every ${'9'.repeat(400)} days`,
  'Buy milk 🔁 every weekday',
  'Buy milk 🔁 every weekday when done',
  'Buy milk 🔁 every week when done',
  'Buy milk 🔁 every monday, friday',
  'Buy milk 🔁 every fri and mon and fri',
  'Buy milk 🔁 Every Week',
  'Buy milk 🔁 every 3 fortnights',
  'Buy milk 🔁 every',
  'Buy milk [repeat:: every 2 months when done]',
  'Buy milk 🏁 delete',
  // Title and tags.
  'Buy milk 📅 2026-01-01 ⏫ 🔁 every week',
  'Buy milk #Errand 📅 2026-01-01 #shop',
  'Buy milk #a #A #a/b 📅 2026-01-01',
  '#only 📅 2026-01-01',
  'Buy\u00a0#nbsp 📅 2026-01-01',
  'Buy milk #😀 📅 2026-01-01',
  'Pay rent  [due:: 2026-09-15]  [priority:: high]',
  'Mixed ⏫ [due:: 2026-01-01] #a 📅 2026-02-01 #b',
  '  Buy milk 📅 2026-01-01  ',
  'Buy milk 🆔 abc 📅 2026-01-01',
  'Buy milk 📅 2026-01-01 ^block',
  'x ⏫ #a ⏫ #b ⏫ #c',
  `x ${Array.from({ length: 23 }, (_, i) => `📅 2026-01-${String(i + 1).padStart(2, '0')}`).join(' ')}`,
  '日本語 😀 #tag 📅 2026-01-01'
]

/**
 * Done dates around real zone transitions at midnight: a skipped midnight (Santiago 2024-09-08,
 * Havana 2018-03-11), a repeated one (Havana 2018-11-04, Amman 2021-10-29) and a skipped day
 * (Apia 2011-12-30, Kiritimati 1994-12-31). The Rust replays them through `chrono::Local`.
 */
const LOCAL_ZONES: { zone: string; dates: string[] }[] = [
  {
    zone: 'America/Santiago',
    dates: ['2024-04-06', '2024-04-07', '2024-04-08', '2024-09-07', '2024-09-08', '2024-09-09']
  },
  { zone: 'America/Havana', dates: ['2018-03-11', '2018-11-03', '2018-11-04', '2018-11-05'] },
  { zone: 'Asia/Amman', dates: ['2021-10-28', '2021-10-29', '2021-10-30'] },
  { zone: 'Pacific/Apia', dates: ['2011-12-29', '2011-12-30', '2011-12-31'] },
  { zone: 'Pacific/Kiritimati', dates: ['1994-12-30', '1994-12-31', '1995-01-01'] }
]

function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

const build = (text: string) => buildObsidianTaskImport(text, NOW)

/** `checklist-tasks.ts`: the text an import hands over, from a `- [ ]`, `- [x]` line only. */
function checkboxText(line: string): string | null {
  const item = line.match(/^([ \t]*)([-*+]|\d+[.)]) +(.*)$/)
  const checkbox = item?.[3].match(/^\[([ xX])\](?: +(.*))?$/)
  return checkbox ? (checkbox[2] ?? '').trim() : null
}

function textCase(text: string): unknown {
  const result = inZone('UTC', () => build(text))
  if (result === null) return { text, import: null }
  const completedAt = Object.fromEntries(
    ZONES.slice(1).map(({ zone }) => [zone, inZone(zone, () => build(text)?.completedAt ?? null)])
  )
  return { text, import: result, completedAt }
}

function fixtureCases(): unknown[] {
  const files = fs.readdirSync(FIXTURES).toSorted()
  return files.flatMap((file) =>
    fs
      .readFileSync(path.join(FIXTURES, file), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('<!--'))
      .map((line) => {
        const text = checkboxText(line)
        return {
          file,
          line,
          parsed: parseObsidianTaskLine(line),
          text,
          import: text === null ? null : inZone('UTC', () => build(text))
        }
      })
  )
}

function render(): string {
  const document = {
    meta: {
      spec: 'tauri-v2-3549-obsidian-task-import',
      oracle:
        'apps/desktop/src/main/import/__vectors__/obsidian-task-import-vectors.test.ts (buildObsidianTaskImport of packages/shared/src/obsidian-task-import.ts, parseObsidianTaskLine of obsidian-tasks.ts)',
      note: '`import` is built in UTC; `completedAt` names the other zones. `localZones` builds done dates in real zones.'
    },
    now: NOW.toISOString(),
    zones: ZONES,
    cases: TEXTS.map(textCase),
    localZones: LOCAL_ZONES.map(({ zone, dates }) => ({
      zone,
      cases: dates.map((date) => {
        const text = `x ✅ ${date}`
        return { text, completedAt: inZone(zone, () => build(text)?.completedAt ?? null) }
      })
    })),
    fixtures: fixtureCases()
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

describe('obsidian task import vectors', () => {
  it('switches the process time zone', () => {
    for (const { zone, offset } of ZONES) {
      expect(inZone(zone, () => new Date(2026, 0, 1).getTimezoneOffset())).toBe(offset)
    }
    expect(inZone('America/Santiago', () => new Date(2024, 8, 8).toISOString())).toBe(
      '2024-09-08T04:00:00.000Z'
    )
  })

  it('matches the committed file', () => {
    const fresh = render()
    if (process.env.MEMRY_WRITE_VECTORS === '1') {
      fs.writeFileSync(VECTOR_FILE, fresh, 'utf8')
      return
    }
    expect(fs.readFileSync(VECTOR_FILE, 'utf8')).toBe(fresh)
  })
})
