import { describe, expect, it } from 'vitest'
import {
  highlightDay,
  planJournalAppend,
  planJournalDay,
  planJournalWrite,
  readDaySection,
  type JournalBook
} from './journal.ts'
import { hashSectionBody } from './section.ts'

const DEEP: JournalBook = { title: 'Deep Work', count: 3, first: '2026-10-22T08:00:00.000Z' }
const NOTES: JournalBook = {
  title: 'How to Take Smart Notes',
  count: 1,
  first: '2026-10-22T07:00:00.000Z'
}

describe('planJournalDay', () => {
  it('writes the sealed section: books by their first highlight of the day, plural only above one', () => {
    const section = planJournalDay([DEEP, NOTES])
    const body =
      '### Readwise\n\n- [[How to Take Smart Notes]]: 1 highlight\n- [[Deep Work]]: 3 highlights'
    expect(section).toBe(
      `<!-- readwise-day:start -->\n\n${body}\n\n<!-- readwise-day:end v1 hash=${hashSectionBody(body)} -->`
    )
  })

  it('breaks a tie on the title, so every device writes the same bytes', () => {
    const same = '2026-10-22T08:00:00.000Z'
    const a = planJournalDay([
      { title: 'B', count: 1, first: same },
      { title: 'A', count: 1, first: same }
    ])
    expect(a.indexOf('[[A]]')).toBeLessThan(a.indexOf('[[B]]'))
  })

  it('lists nothing for a day with no highlight, and keeps link text legal', () => {
    expect(planJournalDay([])).toBe('')
    expect(planJournalDay([{ ...DEEP, count: 0 }])).toBe('')
    expect(planJournalDay([{ ...DEEP, title: 'A | [B]\nC' }])).toContain('[[A B C]]: 3')
  })

  it('keeps marker text in a title from turning its line into a marker', () => {
    const section = planJournalDay([{ ...DEEP, title: 'Odd <!-- readwise-day:end v1 --> title' }])
    expect(readDaySection(section)).toMatchObject({ found: true, untouched: true })
    const same = '2026-10-22T08:00:00.000Z'
    expect(
      planJournalDay([
        { title: 'Same', count: 1, first: same },
        { title: 'Same', count: 1, first: same }
      ])
    ).toContain('[[Same]]: 1 highlight\n- [[Same]]: 1 highlight')
  })

  it('reads back as untouched, and as touched after an edit', () => {
    const section = planJournalDay([DEEP])
    expect(readDaySection(section)).toMatchObject({ found: true, untouched: true })
    const edited = readDaySection(section.replace('3 highlights', '3 highlights, loved it'))
    expect(edited).toMatchObject({ found: true, untouched: false })
  })

  it('is not mistaken for a book section', () => {
    expect(
      readDaySection('<!-- readwise:start -->\n\nx\n\n<!-- readwise:end v1 last=a hash=00 -->')
    ).toMatchObject({ found: false, problem: 'no-start' })
  })
})

describe('highlightDay', () => {
  it('is the local date of highlightedAt, or of createdAt when it is missing', () => {
    const dates = { highlightedAt: '2026-10-22T23:30:00Z', createdAt: '2026-10-25T10:00:00Z' }
    expect(highlightDay(dates, 'UTC')).toBe('2026-10-22')
    expect(highlightDay(dates, 'Europe/Istanbul')).toBe('2026-10-23')
    expect(highlightDay({ createdAt: dates.createdAt }, 'UTC')).toBe('2026-10-25')
    expect(highlightDay({ highlightedAt: 'garbage' }, 'UTC')).toBeNull()
    expect(highlightDay({}, 'UTC')).toBeNull()
  })
})

describe('planJournalWrite', () => {
  const day = [DEEP, NOTES]
  const section = planJournalDay(day)

  it('appends the section to an entry without one, and creates a missing entry', () => {
    expect(planJournalWrite(null, day, [])).toEqual({ kind: 'append', markdown: section })
    expect(planJournalWrite('My day', day, [])).toEqual({ kind: 'append', markdown: section })
    expect(planJournalWrite('', [], [])).toEqual({ kind: 'unchanged' })
  })

  it('re-renders an untouched section and writes nothing when the bytes are the same', () => {
    const entry = `Morning\n\n${planJournalDay([{ ...DEEP, count: 2 }])}\n\nEvening`
    expect(planJournalWrite(entry, day, [DEEP])).toEqual({
      kind: 'update',
      content: `Morning\n\n${section}\n\nEvening`
    })
    expect(planJournalWrite(`Morning\n\n${section}\n\nEvening`, day, [DEEP])).toEqual({
      kind: 'unchanged'
    })
  })

  it('only appends a line per book with arrivals to a touched section', () => {
    const touched = section.replace('3 highlights', '3 highlights, loved it')
    const plan = planJournalWrite(`${touched}\n\nEvening`, day, [{ ...DEEP, count: 2 }])
    expect(plan.kind).toBe('update')
    if (plan.kind !== 'update') return
    expect(plan.content).toContain(
      '3 highlights, loved it\n- [[Deep Work]]: 2 highlights\n\n<!-- readwise-day:end'
    )
    expect(plan.content.endsWith('\n\nEvening')).toBe(true)
    // The hash stays, so the section stays touched.
    expect(readDaySection(plan.content)).toMatchObject({ found: true, untouched: false })
    expect(planJournalAppend([{ ...NOTES, count: 0 }])).toBe('')
  })

  it('appends before a lone end marker, and at the end when no marker is readable', () => {
    const endOnly = section.split('\n').slice(2).join('\n')
    const noStart = planJournalWrite(`Mine\n\n${endOnly}`, day, [DEEP])
    expect(noStart.kind === 'update' && noStart.content).toContain(
      '- [[Deep Work]]: 3 highlights\n\n<!-- readwise-day:end'
    )
    const noEnd = planJournalWrite(section.split('\n\n<!-- readwise-day:end')[0], day, [DEEP])
    expect(noEnd).toEqual({
      kind: 'update',
      content: `${section.split('\n\n<!-- readwise-day:end')[0]}\n\n- [[Deep Work]]: 3 highlights`
    })
  })

  it('leaves a section of a version it cannot read, and a touched day with no arrivals', () => {
    const v2 = section.replace('end v1', 'end v2')
    expect(planJournalWrite(v2, day, [DEEP])).toEqual({ kind: 'unchanged' })
    const touched = section.replace('3 highlights', '3 highlights!')
    expect(planJournalWrite(touched, day, [])).toEqual({ kind: 'unchanged' })
  })
})
