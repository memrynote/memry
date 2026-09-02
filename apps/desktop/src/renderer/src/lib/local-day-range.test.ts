import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localDayRange } from './local-day-range'

/**
 * The renderer project runs on vitest's `threads` pool, where `process.env` is a worker copy and
 * assigning `TZ` never reaches the C++ `tzset` that would move the clock. `use-today.test.tsx`
 * documents the same wall. So the zone matrix runs `localDayRange` in a child `node` with a real
 * `TZ`, which is the only way to prove the fix on a CI runner that sits at UTC, where the two
 * old implementations happened to agree.
 *
 * Node strips the types off the module on import, which works because it has no imports of its
 * own. Keep it that way, or this file loses its teeth. Vite rewrites `import.meta.url` to an http
 * dev-server URL that `node` cannot import, so the path comes from vitest's `testPath`.
 */
const MODULE_PATH = resolve(dirname(expect.getState().testPath!), 'local-day-range.ts')
const MODULE_URL = pathToFileURL(MODULE_PATH).href

function rangeIn(tz: string, date: string): { startAt: string; endAt: string } {
  const source = `
    const { localDayRange } = await import(${JSON.stringify(MODULE_URL)})
    process.stdout.write(JSON.stringify(localDayRange(${JSON.stringify(date)})))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8'
  })
  return JSON.parse(out)
}

describe('localDayRange spans exactly one local day', () => {
  // Two negative offsets, a half-hour offset, a three-quarter-hour offset, the two extremes, and
  // UTC. The expectations are hand-computed from each zone's offset on that date.
  it.each([
    ['UTC', '2026-06-24', '2026-06-24T00:00:00.000Z', '2026-06-25T00:00:00.000Z'],
    ['America/Los_Angeles', '2026-06-24', '2026-06-24T07:00:00.000Z', '2026-06-25T07:00:00.000Z'],
    ['Pacific/Marquesas', '2026-06-24', '2026-06-24T09:30:00.000Z', '2026-06-25T09:30:00.000Z'],
    ['Asia/Kolkata', '2026-06-24', '2026-06-23T18:30:00.000Z', '2026-06-24T18:30:00.000Z'],
    ['Australia/Eucla', '2026-06-24', '2026-06-23T15:15:00.000Z', '2026-06-24T15:15:00.000Z'],
    ['Pacific/Kiritimati', '2026-06-24', '2026-06-23T10:00:00.000Z', '2026-06-24T10:00:00.000Z']
  ])('%s on %s', (tz, date, startAt, endAt) => {
    expect(rangeIn(tz, date)).toEqual({ startAt, endAt })
  })

  // A `start + 24h` end would be an hour wrong on both of these, in opposite directions.
  it.each([
    ['America/Los_Angeles', '2026-03-08', 23],
    ['America/Los_Angeles', '2026-11-01', 25],
    ['Australia/Lord_Howe', '2026-04-05', 24.5]
  ])('%s on %s is a %s hour day', (tz, date, hours) => {
    const { startAt, endAt } = rangeIn(tz, date)
    expect(Date.parse(endAt) - Date.parse(startAt)).toBe(hours * 60 * 60 * 1000)
  })

  it('a local-evening event in a westerly zone falls inside the day it belongs to', () => {
    const { startAt, endAt } = rangeIn('America/Los_Angeles', '2026-06-24')
    // 22:00 local on the 24th is 05:00Z on the 25th, the instant #1920 reported.
    const at = '2026-06-25T05:00:00.000Z'
    expect(at >= startAt && at < endAt).toBe(true)
  })

  it('midnight belongs to the day that starts, not the one that ends', () => {
    const previous = rangeIn('America/Los_Angeles', '2026-06-23')
    const current = rangeIn('America/Los_Angeles', '2026-06-24')
    expect(previous.endAt).toBe(current.startAt)
  })
})

describe('localDayRange in the host zone', () => {
  // Zone-independent properties, so these still say something on a machine the matrix above
  // cannot enumerate.
  it.each(['2026-06-24', '2026-01-01', '2026-12-31', '2028-02-29'])('%s', (date) => {
    const [year, month, day] = date.split('-').map(Number)
    const { startAt, endAt } = localDayRange(date)
    const start = new Date(startAt)
    const end = new Date(endAt)

    expect([start.getFullYear(), start.getMonth() + 1, start.getDate()]).toEqual([year, month, day])
    expect([
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds()
    ]).toEqual([0, 0, 0, 0])
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      0, 0, 0, 0
    ])
    expect(end.getTime() - start.getTime()).toBe(
      new Date(year, month - 1, day + 1).getTime() - new Date(year, month - 1, day).getTime()
    )
  })

  it('holds every local hour of the day, whatever this machine is set to', () => {
    const { startAt, endAt } = localDayRange('2026-06-24')
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(2026, 5, 24, hour, 30).toISOString()
      expect({ hour, inside: at >= startAt && at < endAt }).toEqual({ hour, inside: true })
    }
  })
})

// The zone matrix imports the module into a bare `node`, which resolves no aliases. If the
// module ever grows an import, the matrix starts throwing instead of asserting.
it('local-day-range.ts stays import-free', () => {
  expect(readFileSync(MODULE_PATH, 'utf8')).not.toMatch(/^\s*import\s/m)
})

// A behavioural test cannot tell the two windows apart on a UTC CI runner, so the rule that keeps
// the fix from creeping back is structural: no renderer module rebuilds a day window by pinning a
// date to UTC midnight. `T00:00:00` without the `Z` is a local parse and stays allowed (#1954).
it('no renderer module pins a day window to UTC midnight', () => {
  const root = resolve(dirname(expect.getState().testPath!), '..')
  // `git grep` exits 1 when nothing matches, which is the healthy end state once the comments
  // that still name the literal stop doing so.
  let matched = ''
  try {
    matched = execFileSync('git', ['grep', '-l', 'T00:00:00\\.000Z', '--', root], {
      encoding: 'utf8'
    })
  } catch {
    matched = ''
  }
  const offenders = matched
    .split('\n')
    .filter(Boolean)
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
    .filter((file) => {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      return code.some((line) => line.includes('T00:00:00.000Z'))
    })

  expect(offenders).toEqual([])
})
