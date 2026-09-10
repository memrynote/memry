import { describe, expect, it } from 'vitest'
import {
  describeNoteSaveStatus,
  noteSaveStatus,
  type NoteSaveInputs,
  type NoteSaveStatus
} from '../save-status'

/** The resting state: nothing typed, nothing queued, connected. */
const settled: NoteSaveInputs = {
  dirty: false,
  queued: 0,
  online: true,
  pushing: false,
  parked: false
}

describe('noteSaveStatus', () => {
  it('is synced and invisible when the queue for this note is empty', () => {
    expect(noteSaveStatus(settled)).toBe('synced')
    expect(describeNoteSaveStatus('synced')).toBeNull()
  })

  it('reports saving while the guest may still be holding edits', () => {
    expect(noteSaveStatus({ ...settled, dirty: true })).toBe('saving')
    // Even offline: the handoff being reported is local, and it works with no
    // network at all.
    expect(noteSaveStatus({ ...settled, dirty: true, online: false, queued: 2 })).toBe('saving')
  })

  it('reports pending once the edit is durable but still queued', () => {
    expect(noteSaveStatus({ ...settled, queued: 1 })).toBe('pending')
  })

  it('reports syncing only while a push pass is actually running', () => {
    expect(noteSaveStatus({ ...settled, queued: 1, pushing: true })).toBe('syncing')
    expect(noteSaveStatus({ ...settled, queued: 1, pushing: false })).toBe('pending')
  })

  it('never says syncing offline, even with a pass still in flight', () => {
    expect(noteSaveStatus({ ...settled, queued: 1, online: false, pushing: true })).toBe('offline')
  })

  it('never says syncing while writes are parked', () => {
    // A parked pass reads the read-only policy and returns without sending a
    // row, so "Syncing…" would be a straight lie.
    expect(noteSaveStatus({ ...settled, queued: 1, parked: true, pushing: true })).toBe('pending')
  })

  it('walks one edit from typing to synced', () => {
    // Typing.
    let input: NoteSaveInputs = { ...settled, dirty: true }
    expect(noteSaveStatus(input)).toBe('saving')
    // The debounced flush resolved: durable here, queued for the server.
    input = { ...input, dirty: false, queued: 1 }
    expect(noteSaveStatus(input)).toBe('pending')
    // A drain picked it up.
    input = { ...input, pushing: true }
    expect(noteSaveStatus(input)).toBe('syncing')
    // The server accepted it, so the row was deleted.
    input = { ...input, pushing: false, queued: 0 }
    expect(noteSaveStatus(input)).toBe('synced')
  })

  it('walks the offline round trip back to synced', () => {
    let input: NoteSaveInputs = { ...settled, dirty: true, online: false }
    expect(noteSaveStatus(input)).toBe('saving')
    input = { ...input, dirty: false, queued: 1 }
    expect(noteSaveStatus(input)).toBe('offline')
    // Reconnected; the drain the online edge fires has not started yet.
    input = { ...input, online: true }
    expect(noteSaveStatus(input)).toBe('pending')
    input = { ...input, pushing: true }
    expect(noteSaveStatus(input)).toBe('syncing')
    input = { ...input, pushing: false, queued: 0 }
    expect(noteSaveStatus(input)).toBe('synced')
  })

  it('says nothing about the server for a state that has not reached it', () => {
    // The invariant the indicator exists to keep: only an empty queue may read
    // as synced, and only an empty queue may render nothing.
    const flags = [false, true]
    for (const dirty of flags) {
      for (const online of flags) {
        for (const pushing of flags) {
          for (const parked of flags) {
            for (const queued of [0, 1, 7]) {
              const status = noteSaveStatus({ dirty, queued, online, pushing, parked })
              if (status === 'synced') {
                expect(queued).toBe(0)
                expect(dirty).toBe(false)
              }
              if (describeNoteSaveStatus(status) === null) expect(status).toBe('synced')
            }
          }
        }
      }
    }
  })
})

describe('describeNoteSaveStatus', () => {
  it('gives every visible state a distinct word and a fuller spoken sentence', () => {
    const visible: NoteSaveStatus[] = ['saving', 'syncing', 'pending', 'offline']
    const seen = new Set<string>()
    for (const status of visible) {
      const described = describeNoteSaveStatus(status)
      expect(described).not.toBeNull()
      expect(described!.text.length).toBeGreaterThan(0)
      // The visible word alone under-explains; VoiceOver gets the sentence.
      expect(described!.accessibilityLabel.length).toBeGreaterThan(described!.text.length)
      seen.add(described!.text)
    }
    expect(seen.size).toBe(visible.length)
  })
})
