import { describe, it, expect } from 'vitest'
import { buildTemplateApplyUpdate } from './apply-template'
import type { Template } from '@memry/contracts/templates-api'

const template: Template = {
  id: 't1',
  name: 'Meeting',
  description: undefined,
  icon: null,
  isBuiltIn: false,
  tags: ['meeting', 'work'],
  properties: [
    { name: 'status', type: 'select', value: 'scheduled', options: ['scheduled', 'done'] },
    { name: 'attendees', type: 'text', value: '' }
  ],
  content: '# {{title}}\n\n## Notes\n',
  createdAt: '2026-07-08T00:00:00.000Z',
  modifiedAt: '2026-07-08T00:00:00.000Z'
}

const note = {
  id: 'n1',
  title: 'Standup',
  tags: ['work', 'daily'],
  properties: { status: 'done', priority: 5 }
  // other Note fields unused by buildTemplateApplyUpdate
} as unknown as import('../vault/notes').Note

describe('buildTemplateApplyUpdate', () => {
  it('resolves {{title}} to the note title in the body', () => {
    const u = buildTemplateApplyUpdate(note, template, 'full')
    expect(u.content).toContain('# Standup')
    expect(u.content).not.toContain('{{title}}')
  })

  it('full mode: unions tags and merges properties with existing winning', () => {
    const u = buildTemplateApplyUpdate(note, template, 'full')
    expect(new Set(u.tags)).toEqual(new Set(['work', 'daily', 'meeting']))
    // existing status 'done' wins over template 'scheduled'; template adds 'attendees'; existing priority kept
    expect(u.properties).toEqual({ status: 'done', priority: 5, attendees: '' })
  })

  it('body mode: leaves tags and properties undefined (untouched by updateNote)', () => {
    const u = buildTemplateApplyUpdate(note, template, 'body')
    expect(u.tags).toBeUndefined()
    expect(u.properties).toBeUndefined()
    expect(u.content).toContain('## Notes')
  })

  it('always targets the note id', () => {
    expect(buildTemplateApplyUpdate(note, template, 'full').id).toBe('n1')
  })
})
