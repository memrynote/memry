import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagSchemaCommandResult, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { addPresetTag, createObject, lastCreateTag } from './create-object'

type Fn = ReturnType<typeof vi.fn>
const notes = (window.api as unknown as { notes: Record<string, Fn> }).notes

const snapshotWith = (presetName?: string): TagSchemaSnapshot => ({
  tags: {},
  objects: {},
  presets: presetName
    ? [
        {
          key: 'person',
          name: presetName,
          icon: null,
          color: 'blue',
          fields: [],
          templateSections: [],
          state: 'added',
          existingTag: null,
          alsoAdds: []
        }
      ]
    : [],
  presetStripDismissed: false
})

describe('createObject', () => {
  beforeEach(() => {
    notes.create = vi.fn().mockResolvedValue({ success: true, note: { id: 'n1', title: 'Ada' } })
  })

  it('creates an empty note carrying the tag and returns its id and stored title', async () => {
    await expect(createObject({ title: 'Ada', tag: 'person' })).resolves.toEqual({
      id: 'n1',
      title: 'Ada'
    })
    expect(notes.create).toHaveBeenCalledWith({ title: 'Ada', content: '', tags: ['person'] })
  })

  it('passes initial properties through', async () => {
    await createObject({ title: 'Ada', tag: 'person', properties: { Role: 'Engineer' } })

    expect(notes.create).toHaveBeenCalledWith({
      title: 'Ada',
      content: '',
      tags: ['person'],
      properties: { Role: 'Engineer' }
    })
  })

  it('throws the main-process error when creation fails', async () => {
    notes.create = vi.fn().mockResolvedValue({ success: false, error: 'vault is read-only' })

    await expect(createObject({ title: 'Ada', tag: 'person' })).rejects.toThrow(
      'vault is read-only'
    )
  })

  it('throws a generic error when creation fails without a message', async () => {
    notes.create = vi.fn().mockResolvedValue({ success: true, note: null })

    await expect(createObject({ title: 'Ada', tag: 'person' })).rejects.toThrow('create failed')
  })
})

describe('addPresetTag', () => {
  it('returns the folded key of the tag the command wrote', async () => {
    const edit = vi.fn().mockResolvedValue({ snapshot: snapshotWith(), tag: 'Person' })

    await expect(addPresetTag(edit, 'person')).resolves.toBe('person')
    expect(edit).toHaveBeenCalledWith({ kind: 'add-preset', preset: 'person' })
  })

  it('falls back to the preset name in the returned snapshot', async () => {
    const edit = vi
      .fn<() => Promise<TagSchemaCommandResult>>()
      .mockResolvedValue({ snapshot: snapshotWith('Persona') })

    await expect(addPresetTag(edit, 'person')).resolves.toBe('persona')
  })

  it('throws when the preset shows up nowhere in the result', async () => {
    const edit = vi
      .fn<() => Promise<TagSchemaCommandResult>>()
      .mockResolvedValue({ snapshot: snapshotWith() })

    await expect(addPresetTag(edit, 'person')).rejects.toThrow('preset not added')
  })
})

describe('lastCreateTag', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('remembers the last tag across reads and starts empty', () => {
    expect(lastCreateTag.get()).toBeNull()

    lastCreateTag.set('company')

    expect(lastCreateTag.get()).toBe('company')
  })

  it('reads as empty and does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(() => lastCreateTag.set('company')).not.toThrow()
    expect(lastCreateTag.get()).toBeNull()
  })
})
