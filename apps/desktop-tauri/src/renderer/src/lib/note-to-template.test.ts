import { describe, it, expect } from 'vitest'
import { buildTemplateFromNote } from './note-to-template'
import type { PropertyValue } from './property-utils'

function source(overrides: Partial<Parameters<typeof buildTemplateFromNote>[0]> = {}) {
  return { title: 'Weekly review', content: '', tags: [], properties: [], ...overrides }
}

describe('buildTemplateFromNote', () => {
  it('copies tags, dropping blanks and duplicates while preserving first-seen order', () => {
    const result = buildTemplateFromNote(
      source({ tags: ['review', '', 'weekly', '   ', 'review', 'notes'] })
    )
    expect(result.tags).toEqual(['review', 'weekly', 'notes'])
  })

  it('maps every UI property type onto its stored type', () => {
    const properties: PropertyValue[] = [
      { name: 'Summary', type: 'text', value: 'a' },
      { name: 'Count', type: 'number', value: 3 },
      { name: 'Due', type: 'date', value: '2026-01-01' },
      { name: 'Done', type: 'checkbox', value: true },
      { name: 'Link', type: 'url', value: 'https://memry.app' },
      { name: 'Stage', type: 'status', value: 'todo' },
      { name: 'Pick', type: 'select', value: 'one' },
      { name: 'Picks', type: 'multiselect', value: ['one'] },
      { name: 'Project', type: 'project', value: ['Apollo'] }
    ]

    expect(buildTemplateFromNote(source({ properties })).properties).toEqual([
      { name: 'Summary', type: 'text', value: 'a' },
      { name: 'Count', type: 'number', value: 3 },
      { name: 'Due', type: 'date', value: '2026-01-01' },
      { name: 'Done', type: 'checkbox', value: true },
      { name: 'Link', type: 'url', value: 'https://memry.app' },
      { name: 'Stage', type: 'select', value: 'todo' },
      { name: 'Pick', type: 'select', value: 'one' },
      { name: 'Picks', type: 'multiselect', value: ['one'] },
      { name: 'Project', type: 'project', value: ['Apollo'] }
    ])
  })

  it('drops relation properties instead of flattening them', () => {
    const properties: PropertyValue[] = [
      { name: 'Related', type: 'relation', value: ['memry://note/1'] },
      { name: 'Summary', type: 'text', value: 'a' }
    ]

    expect(buildTemplateFromNote(source({ properties })).properties).toEqual([
      { name: 'Summary', type: 'text', value: 'a' }
    ])
  })

  it('never carries options, which the note side has no source for', () => {
    const properties: PropertyValue[] = [{ name: 'Pick', type: 'select', value: 'one' }]
    expect(buildTemplateFromNote(source({ properties })).properties?.[0]).not.toHaveProperty(
      'options'
    )
  })

  it('trims the title', () => {
    expect(buildTemplateFromNote(source({ title: '  Weekly review  ' })).name).toBe('Weekly review')
  })

  it('truncates the title at 200 characters', () => {
    const result = buildTemplateFromNote(source({ title: 'x'.repeat(250) }))
    expect(result.name).toHaveLength(200)
    expect(result.name).toBe('x'.repeat(200))
  })

  it('yields an empty name for an empty or whitespace-only title', () => {
    expect(buildTemplateFromNote(source({ title: '' })).name).toBe('')
    expect(buildTemplateFromNote(source({ title: '   \n\t ' })).name).toBe('')
  })

  it('passes the body through unchanged, including its own title text', () => {
    const content =
      '# Weekly review\n\nWeekly review notes for {{title}} and Weekly review again.\n'
    const result = buildTemplateFromNote(source({ title: 'Weekly review', content }))
    expect(result.content).toBe(content)
  })
})
