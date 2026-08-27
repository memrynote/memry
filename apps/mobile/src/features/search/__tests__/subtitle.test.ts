import { describe, expect, it } from 'vitest'
import type { NoteHit, TaskHit } from '../repo'
import {
  formatEditedAt,
  formatJournalDate,
  localIsoDay,
  noteSubtitle,
  snippetAround,
  taskSubtitle
} from '../subtitle'

/**
 * The text under every search row.
 *
 * Two of these rules come from the runtime rather than the design. No date is
 * formatted through `toLocaleDateString`, because Hermes ships without ICU on
 * some React Native configurations and the call then returns another format or
 * throws. And no `YYYY-MM-DD` string is handed to `new Date`, which reads it as
 * UTC midnight and renders the day before it anywhere west of Greenwich — so
 * the assertions below build their timestamps in local time, and stay true in
 * every timezone the suite might run in.
 */

const NOW = new Date(2026, 7, 27, 12, 0, 0).getTime()
const TODAY = '2026-08-27'

function task(overrides: Partial<TaskHit> = {}): TaskHit {
  return {
    kind: 'task',
    id: 't1',
    title: 'Ship it',
    dueDate: null,
    completedAt: null,
    projectName: null,
    ...overrides
  }
}

describe('formatEditedAt', () => {
  it('says "just now" for the first minute and switches to minutes on the boundary', () => {
    expect(formatEditedAt(NOW, NOW)).toBe('just now')
    expect(formatEditedAt(NOW - 59_999, NOW)).toBe('just now')
    expect(formatEditedAt(NOW - 60_000, NOW)).toBe('edited 1 m ago')
  })

  it('counts whole minutes up to the hour, then whole hours up to the day', () => {
    expect(formatEditedAt(NOW - 3_599_999, NOW)).toBe('edited 59 m ago')
    expect(formatEditedAt(NOW - 3_600_000, NOW)).toBe('edited 1 h ago')
    expect(formatEditedAt(NOW - 86_399_999, NOW)).toBe('edited 23 h ago')
  })

  it('falls back to a calendar date past a day, with no zero-padded day', () => {
    expect(formatEditedAt(NOW - 86_400_000, NOW)).toBe('26 Aug')
    expect(formatEditedAt(new Date(2026, 0, 5, 12, 0, 0).getTime(), NOW)).toBe('5 Jan')
  })

  it('adds the year only when it is not the year we are in', () => {
    expect(formatEditedAt(new Date(2026, 7, 12, 12, 0, 0).getTime(), NOW)).toBe('12 Aug')
    expect(formatEditedAt(new Date(2025, 7, 12, 12, 0, 0).getTime(), NOW)).toBe('12 Aug 2025')
  })
})

describe('localIsoDay', () => {
  it('reports the LOCAL calendar day, not the UTC one', () => {
    // Both ends of the day, because only one of them lands on a different UTC
    // date and which one depends on the runner's zone. `toISOString()` would
    // name the wrong day for a task due tonight, reading it as overdue or as
    // due tomorrow, and asserting only one end would pass in half the world.
    expect(localIsoDay(new Date(2026, 7, 26, 0, 30).getTime())).toBe('2026-08-26')
    expect(localIsoDay(new Date(2026, 7, 26, 23, 30).getTime())).toBe('2026-08-26')
  })

  it('zero-pads month and day so the strings compare correctly', () => {
    // The comparisons in `taskSubtitle` are plain string `<`, which only holds
    // because every field is fixed width.
    expect(localIsoDay(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05')
  })
})

describe('formatJournalDate', () => {
  it('reads the day and month out of the string, unpadded and unabbreviated', () => {
    expect(formatJournalDate('2026-08-26')).toBe('26 August')
    expect(formatJournalDate('2026-08-06')).toBe('6 August')
  })

  it('returns anything that is not a real calendar date untouched', () => {
    expect(formatJournalDate('yesterday')).toBe('yesterday')
    expect(formatJournalDate('2026-13-01')).toBe('2026-13-01')
  })
})

describe('noteSubtitle', () => {
  it('leads with the folder when the note is in one', () => {
    const hit: NoteHit = {
      kind: 'note',
      id: 'n1',
      title: 'Standup',
      folderPath: 'Work/Meetings',
      updatedAt: NOW
    }
    expect(noteSubtitle(hit, NOW)).toBe('Work/Meetings · just now')
    expect(noteSubtitle({ ...hit, folderPath: null }, NOW)).toBe('just now')
  })
})

describe('taskSubtitle', () => {
  it('says Done for a completed task, whatever its due date was', () => {
    expect(
      taskSubtitle(
        task({ completedAt: '2026-08-20T09:00:00.000Z', dueDate: '2026-01-01', projectName: 'Q4' }),
        TODAY
      )
    ).toBe('Done · Q4')
  })

  it('names the relative day for yesterday, today and tomorrow', () => {
    expect(taskSubtitle(task({ dueDate: '2026-08-26' }), TODAY)).toBe('Overdue')
    expect(taskSubtitle(task({ dueDate: '2026-08-27' }), TODAY)).toBe('Due today')
    expect(taskSubtitle(task({ dueDate: '2026-08-28' }), TODAY)).toBe('Due tomorrow')
  })

  it('finds tomorrow across a month boundary', () => {
    expect(taskSubtitle(task({ dueDate: '2026-09-01' }), '2026-08-31')).toBe('Due tomorrow')
  })

  it('falls back to a bare day and month further out, with no year', () => {
    expect(taskSubtitle(task({ dueDate: '2026-09-12' }), TODAY)).toBe('Due 12 Sep')
  })

  it('drops the segments it has nothing to say about', () => {
    expect(taskSubtitle(task({ projectName: 'Q4' }), TODAY)).toBe('Q4')
    expect(taskSubtitle(task({ dueDate: '2026-09-12', projectName: 'Q4' }), TODAY)).toBe(
      'Due 12 Sep · Q4'
    )
    expect(taskSubtitle(task(), TODAY)).toBe('')
  })
})

describe('snippetAround', () => {
  it('collapses whitespace and adds no ellipsis when the whole text fits', () => {
    expect(snippetAround('  Memry   keeps\nnotes  ', 'memry')).toBe('Memry keeps notes')
  })

  it('marks only the end when the match is at the start of a long body', () => {
    expect(snippetAround(`needle ${'b'.repeat(200)}`, 'needle')).toBe(`needle ${'b'.repeat(57)}…`)
  })

  it('centres the match and marks both ends when it sits in the middle', () => {
    const content = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`
    expect(snippetAround(content, 'needle')).toBe(`…${'a'.repeat(28)} needle ${'b'.repeat(28)}…`)
  })

  it('returns nothing when the query is not in the body', () => {
    expect(snippetAround('nothing here', 'roadmap')).toBeNull()
  })
})
