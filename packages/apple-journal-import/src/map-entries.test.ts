import { describe, it, expect } from 'vitest'
import { mapEntry } from './map-entries.ts'
import type { JournalEntryInput } from './types.ts'

const base: JournalEntryInput = {
  date: '2024-11-03',
  bodyMarkdown: 'Hello world',
  reflection: null,
  overlayValues: [],
  filenameStem: '2024-11-03'
}

describe('mapEntry', () => {
  it('uses ISO date as title when date is available', () => {
    const plan = mapEntry(base)
    expect(plan.title).toBe('2024-11-03')
  })

  it('falls back to filenameStem when date is null', () => {
    const plan = mapEntry({ ...base, date: null })
    expect(plan.title).toBe('2024-11-03')
  })

  it('always sets folder to Apple Journal', () => {
    expect(mapEntry(base).folder).toBe('Apple Journal')
  })

  it('sets created from date', () => {
    expect(mapEntry(base).created).toBe('2024-11-03')
  })

  it('created is undefined when date is null', () => {
    expect(mapEntry({ ...base, date: null }).created).toBeUndefined()
  })

  it('includes body markdown in content', () => {
    const plan = mapEntry({ ...base, bodyMarkdown: 'paragraph text' })
    expect(plan.content).toContain('paragraph text')
  })

  it('appends reflection as blockquote when present', () => {
    const plan = mapEntry({ ...base, reflection: 'What did you learn?' })
    expect(plan.content).toContain('> What did you learn?')
  })

  it('includes token-derived properties', () => {
    const plan = mapEntry({ ...base, overlayValues: ['generic-map'] })
    expect(plan.properties).toMatchObject({ location: true })
  })

  it('includes date property when date is set', () => {
    const plan = mapEntry(base)
    expect(plan.properties).toMatchObject({ date: '2024-11-03' })
  })
})
