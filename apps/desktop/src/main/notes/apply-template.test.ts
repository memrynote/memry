import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../vault/notes', () => ({
  getNoteById: vi.fn()
}))
vi.mock('../vault/templates', async (importActual) => {
  const actual = await importActual<typeof import('../vault/templates')>()
  return { ...actual, getTemplate: vi.fn() }
})
vi.mock('./domain', () => ({
  updateNoteCommand: vi.fn()
}))
vi.mock('../sync/crdt-feed', () => ({
  replaceNoteBodyInCrdt: vi.fn(),
  replaceNoteTagsInCrdt: vi.fn()
}))

import { buildTemplateApplyUpdate, applyTemplateToNote } from './apply-template'
import { getNoteById } from '../vault/notes'
import { getTemplate } from '../vault/templates'
import { updateNoteCommand } from './domain'
import { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from '../sync/crdt-feed'
import { NoteError, VaultError } from '../lib/errors'
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

describe('applyTemplateToNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws NoteError when the note does not exist', async () => {
    vi.mocked(getNoteById).mockResolvedValue(null)
    await expect(
      applyTemplateToNote({ noteId: 'missing', templateId: 't1', mode: 'full' })
    ).rejects.toBeInstanceOf(NoteError)
    expect(getTemplate).not.toHaveBeenCalled()
    expect(updateNoteCommand).not.toHaveBeenCalled()
  })

  it('throws VaultError when the template does not exist', async () => {
    vi.mocked(getNoteById).mockResolvedValue(note)
    vi.mocked(getTemplate).mockResolvedValue(null)
    await expect(
      applyTemplateToNote({ noteId: 'n1', templateId: 'gone', mode: 'full' })
    ).rejects.toBeInstanceOf(VaultError)
    expect(updateNoteCommand).not.toHaveBeenCalled()
  })

  it('full mode: persists the merged update and feeds both body and tags to the open editor', async () => {
    vi.mocked(getNoteById).mockResolvedValue(note)
    vi.mocked(getTemplate).mockResolvedValue(template)
    vi.mocked(updateNoteCommand).mockResolvedValue(note)

    const result = await applyTemplateToNote({ noteId: 'n1', templateId: 't1', mode: 'full' })

    expect(result).toBe(note)
    const update = vi.mocked(updateNoteCommand).mock.calls[0][0]
    expect(update.id).toBe('n1')
    expect(new Set(update.tags)).toEqual(new Set(['work', 'daily', 'meeting']))
    expect(replaceNoteBodyInCrdt).toHaveBeenCalledWith('n1', update.content)
    expect(replaceNoteTagsInCrdt).toHaveBeenCalledWith('n1', update.tags)
  })

  it('body mode: replaces the body but does not touch the open editor tags', async () => {
    vi.mocked(getNoteById).mockResolvedValue(note)
    vi.mocked(getTemplate).mockResolvedValue(template)
    vi.mocked(updateNoteCommand).mockResolvedValue(note)

    await applyTemplateToNote({ noteId: 'n1', templateId: 't1', mode: 'body' })

    expect(replaceNoteBodyInCrdt).toHaveBeenCalledTimes(1)
    expect(replaceNoteTagsInCrdt).not.toHaveBeenCalled()
  })
})
