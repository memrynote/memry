import { describe, expect, it } from 'vitest'
import { NotesChannels } from '../../contracts/src/ipc-channels.ts'
import { notesRpc } from './notes.ts'

describe('notesRpc domain shape', () => {
  it('has name "notes"', () => {
    expect(notesRpc.name).toBe('notes')
  })

  it('exposes a reasonable method surface (>= 40 methods)', () => {
    expect(Object.keys(notesRpc.methods).length).toBeGreaterThanOrEqual(40)
  })

  it('every method spec carries a channel, mode, and arg arrays', () => {
    for (const [key, method] of Object.entries(notesRpc.methods)) {
      expect(method.channel, `method ${key}`).toBeTypeOf('string')
      expect(method.channel.length, `method ${key} channel`).toBeGreaterThan(0)
      expect(['invoke', 'sync'], `method ${key} mode`).toContain(method.mode)
      expect(Array.isArray(method.params)).toBe(true)
      expect(Array.isArray(method.invokeArgs)).toBe(true)
    }
  })

  it('every event spec has only a channel key', () => {
    for (const [key, event] of Object.entries(notesRpc.events)) {
      expect(event.channel, `event ${key}`).toBeTypeOf('string')
      expect(Object.keys(event)).toEqual(['channel'])
    }
  })

  it('method channels are unique', () => {
    const channels = Object.values(notesRpc.methods).map((m) => m.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('event channels are unique', () => {
    const channels = Object.values(notesRpc.events).map((e) => e.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('wires CRUD methods to NotesChannels.invoke', () => {
    expect(notesRpc.methods.create.channel).toBe(NotesChannels.invoke.CREATE)
    expect(notesRpc.methods.get.channel).toBe(NotesChannels.invoke.GET)
    expect(notesRpc.methods.update.channel).toBe(NotesChannels.invoke.UPDATE)
    expect(notesRpc.methods.delete.channel).toBe(NotesChannels.invoke.DELETE)
    expect(notesRpc.methods.list.channel).toBe(NotesChannels.invoke.LIST)
  })

  it('wires multi-arg methods to object-shaped invokeArgs', () => {
    expect(notesRpc.methods.rename.invokeArgs).toEqual(['{ id, newTitle }'])
    expect(notesRpc.methods.move.invokeArgs).toEqual(['{ id, newFolder }'])
    expect(notesRpc.methods.reorder.invokeArgs).toEqual(['{ folderPath, notePaths }'])
  })

  it('uploadAttachment uses a custom implementation template', () => {
    expect(notesRpc.methods.uploadAttachment.implementation).toBeTypeOf('string')
    expect(notesRpc.methods.uploadAttachment.implementation).toContain('arrayBuffer')
  })

  it('wires event channels to NotesChannels.events where applicable', () => {
    expect(notesRpc.events.onNoteCreated.channel).toBe(NotesChannels.events.CREATED)
    expect(notesRpc.events.onNoteDeleted.channel).toBe(NotesChannels.events.DELETED)
    expect(notesRpc.events.onTagsChanged.channel).toBe('notes:tags-changed')
  })

  it('list.invokeArgs falls back to empty object literal', () => {
    expect(notesRpc.methods.list.invokeArgs).toEqual(['options ?? {}'])
  })
})
