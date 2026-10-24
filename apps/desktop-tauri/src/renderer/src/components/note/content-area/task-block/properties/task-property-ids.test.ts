import { describe, expect, it } from 'vitest'
import { resolvePropertyShortcut } from './task-property-ids'
import { missingTaskProperties } from './task-block-properties'

const key = (
  k: string,
  mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}
) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })

describe('resolvePropertyShortcut', () => {
  it('maps single keys to properties, with Shift picking the sibling', () => {
    expect(resolvePropertyShortcut(key('s'))).toBe('status')
    expect(resolvePropertyShortcut(key('p'))).toBe('priority')
    expect(resolvePropertyShortcut(key('P', { shiftKey: true }))).toBe('project')
    expect(resolvePropertyShortcut(key('d'))).toBe('due')
    expect(resolvePropertyShortcut(key('D', { shiftKey: true }))).toBe('start')
    expect(resolvePropertyShortcut(key('r'))).toBe('repeat')
    expect(resolvePropertyShortcut(key('h'))).toBe('reminder')
    expect(resolvePropertyShortcut(key('l'))).toBe('tags')
    expect(resolvePropertyShortcut(key('L', { shiftKey: true }))).toBe('related')
    expect(resolvePropertyShortcut(key('e'))).toBe('description')
  })

  it('leaves modified keys and unmapped keys to the app', () => {
    expect(resolvePropertyShortcut(key('l', { metaKey: true }))).toBeNull()
    expect(resolvePropertyShortcut(key('d', { ctrlKey: true }))).toBeNull()
    expect(resolvePropertyShortcut(key('d', { altKey: true }))).toBeNull()
    expect(resolvePropertyShortcut(key('x'))).toBeNull()
    expect(resolvePropertyShortcut(key('Enter'))).toBeNull()
  })
})

describe('missingTaskProperties', () => {
  const bare = {
    description: '',
    isRepeating: false,
    repeatConfig: null,
    tags: [],
    startDate: null,
    dueDate: null,
    linkedNoteIds: ['host-note'],
    linkedCanvasIds: []
  }

  it('offers every optional property of a bare task, in menu order', () => {
    expect(
      missingTaskProperties({ task: bare, hasActiveReminder: false, hostNoteId: 'host-note' })
    ).toEqual(['due', 'start', 'repeat', 'reminder', 'tags', 'description', 'related'])
  })

  // The note holding the task line is linked to it, but that link is not a
  // related item the user set.
  it('does not count the note the block sits in as a related item', () => {
    expect(
      missingTaskProperties({ task: bare, hasActiveReminder: false, hostNoteId: 'host-note' })
    ).toContain('related')
    expect(
      missingTaskProperties({ task: bare, hasActiveReminder: false, hostNoteId: 'other-note' })
    ).not.toContain('related')
  })

  it('offers nothing for a fully specified task', () => {
    const full = {
      ...bare,
      description: 'Notes',
      isRepeating: true,
      repeatConfig: { frequency: 'weekly' } as never,
      tags: ['launch'],
      startDate: new Date(2026, 8, 1),
      dueDate: new Date(2026, 8, 5),
      linkedCanvasIds: ['canvas-1']
    }
    expect(
      missingTaskProperties({ task: full, hasActiveReminder: true, hostNoteId: 'host-note' })
    ).toEqual([])
  })
})
