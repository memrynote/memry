import { describe, expect, it } from 'vitest'
import { hitsFromRows, likePattern, type CandidateRow } from '../repo.sqlite'

/**
 * The LIKE repo's judgement, without a database.
 *
 * Every decision that can be wrong lives in `hitsFromRows`, which takes rows as
 * data — the SQL only narrows. That split is also what makes this file
 * runnable: `repo.sqlite.ts` imports `VaultDb` as a type only, so nothing in
 * its import graph reaches `expo-sqlite`, which has no Node build. A value
 * import there would take this suite down with it.
 */

function row(id: string, type: string, payload: unknown, updatedAt = 1): CandidateRow {
  return { id, type, payload: JSON.stringify(payload), updated_at: updatedAt, markdown: null }
}

/** LIKE with `ESCAPE '\'`, as SQLite reads it. */
function likeMatches(pattern: string, value: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') {
      i += 1
      source += escapeRegex(pattern[i] ?? '')
    } else if (char === '%') {
      source += '[\\s\\S]*'
    } else if (char === '_') {
      source += '[\\s\\S]'
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(`^${source}$`, 'i').test(value)
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('likePattern', () => {
  it('escapes both LIKE wildcards, and the escape character before either', () => {
    // This is the silent-wrong-answer case, not a crash: an unescaped `%` turns
    // the query into a wildcard that matches every note in the vault, and the
    // screen shows a full list that reads as a working search. Escaping the
    // backslash after the wildcards would be just as wrong, because it would
    // escape the escapes the wildcard passes just inserted.
    expect(likePattern('100%')).toBe('%100\\%%')
    expect(likePattern('a_b')).toBe('%a\\_b%')
    expect(likePattern('c:\\tmp')).toBe('%c:\\\\tmp%')
  })

  it('produces a pattern SQLite reads as the literal characters typed', () => {
    expect(likeMatches(likePattern('100%'), 'discount 100% off')).toBe(true)
    expect(likeMatches(likePattern('100%'), 'note about 100 things')).toBe(false)
    expect(likeMatches(likePattern('a_b'), 'a_b')).toBe(true)
    expect(likeMatches(likePattern('a_b'), 'axb')).toBe(false)
    expect(likeMatches(likePattern('c:\\tmp'), 'saved to c:\\tmp today')).toBe(true)
  })
})

describe('hitsFromRows', () => {
  it('drops a payload it cannot parse instead of failing the search', () => {
    const rows: CandidateRow[] = [
      { id: 'broken-json', type: 'note', payload: '{"title":', updated_at: 9, markdown: null },
      row('wrong-shape', 'note', { title: 42 }, 9),
      row('good', 'note', { title: 'Roadmap' }, 1)
    ]
    expect(hitsFromRows(rows, 'roadmap', new Map()).map((hit) => hit.id)).toEqual(['good'])
  })

  it('drops a row the SQL matched on payload internals the user never sees', () => {
    const rows = [
      row('n1', 'note', { title: 'Standup', folderPath: 'Work/Roadmap', content: 'agenda' }),
      row('roadmap-42', 'note', { title: 'Standup', content: 'agenda' })
    ]
    expect(hitsFromRows(rows, 'roadmap', new Map())).toEqual([])
  })

  it('ranks title matches above body-only matches, however much older they are', () => {
    const rows: CandidateRow[] = [
      {
        id: 'body',
        type: 'note',
        payload: JSON.stringify({ title: 'Standup' }),
        updated_at: 900,
        markdown: 'the roadmap for Q4'
      },
      row('title', 'note', { title: 'Roadmap' }, 100)
    ]
    expect(hitsFromRows(rows, 'roadmap', new Map()).map((hit) => hit.id)).toEqual(['title', 'body'])
  })

  it('breaks ties by recency and then by id, so the list never reshuffles itself', () => {
    const rows = [
      row('b', 'note', { title: 'Roadmap' }, 5),
      row('a', 'note', { title: 'Roadmap' }, 5),
      row('c', 'note', { title: 'Roadmap' }, 9)
    ]
    expect(hitsFromRows(rows, 'roadmap', new Map()).map((hit) => hit.id)).toEqual(['c', 'a', 'b'])
  })

  it('titles a note that has none, and treats an empty folder path as no folder', () => {
    const rows = [row('n1', 'note', { folderPath: '', content: 'roadmap notes' }, 5)]
    expect(hitsFromRows(rows, 'roadmap', new Map())).toEqual([
      { kind: 'note', id: 'n1', title: 'Untitled', folderPath: null, updatedAt: 5 }
    ])
  })

  it('resolves a task project name, and still titles a task matched on its description', () => {
    const rows = [
      row('t1', 'task', { description: 'ship the roadmap', projectId: 'p1', dueDate: '2026-09-01' })
    ]
    expect(hitsFromRows(rows, 'roadmap', new Map([['p1', 'Q4 Launch']]))).toEqual([
      {
        kind: 'task',
        id: 't1',
        title: 'Untitled',
        dueDate: '2026-09-01',
        completedAt: null,
        projectName: 'Q4 Launch'
      }
    ])
  })

  it('leaves a task project unnamed when the project is not in the map', () => {
    const rows = [row('t1', 'task', { title: 'Roadmap review', projectId: 'gone' })]
    expect(hitsFromRows(rows, 'roadmap', new Map())[0]).toMatchObject({ projectName: null })
  })

  it('drops a journal with no date, because the date is the whole row', () => {
    const rows = [row('j1', 'journal', { content: 'roadmap planning' })]
    expect(hitsFromRows(rows, 'roadmap', new Map())).toEqual([])
  })

  it('matches a journal on its date and snippets the body around the query', () => {
    const rows = [row('j1', 'journal', { date: '2026-08-26', content: 'wrote the roadmap' }, 7)]
    expect(hitsFromRows(rows, '2026-08', new Map())).toEqual([
      {
        kind: 'journal',
        id: 'j1',
        date: '2026-08-26',
        snippet: null,
        updatedAt: 7
      }
    ])
    expect(hitsFromRows(rows, 'roadmap', new Map())[0]).toMatchObject({
      snippet: 'wrote the roadmap'
    })
  })
})
