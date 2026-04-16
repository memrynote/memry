/**
 * IPC CRDT Contract Tests
 *
 * Covers the Yjs IPC envelope validators. `update`/`stateVector`/`diff` are
 * serialized as number arrays across the IPC boundary (Uint8Array bytes) and
 * the schemas clamp each byte to 0..255.
 */

import { describe, it, expect } from 'vitest'

import {
  CRDT_CHANNELS,
  CRDT_EVENTS,
  CRDT_FRAGMENT_NAME,
  CrdtApplyUpdateSchema,
  CrdtCloseDocSchema,
  CrdtOpenDocSchema,
  CrdtSyncStep1Schema,
  CrdtSyncStep2Schema
} from './ipc-crdt'

describe('CRDT channel constants', () => {
  it('exposes the expected command channels', () => {
    expect(CRDT_CHANNELS.OPEN_DOC).toBe('crdt:open-doc')
    expect(CRDT_CHANNELS.CLOSE_DOC).toBe('crdt:close-doc')
    expect(CRDT_CHANNELS.APPLY_UPDATE).toBe('crdt:apply-update')
    expect(CRDT_CHANNELS.SYNC_STEP_1).toBe('crdt:sync-step-1')
    expect(CRDT_CHANNELS.SYNC_STEP_2).toBe('crdt:sync-step-2')
  })

  it('exposes the expected event channels', () => {
    expect(CRDT_EVENTS.STATE_CHANGED).toBe('crdt:state-changed')
    expect(CRDT_EVENTS.DOC_LOADED).toBe('crdt:doc-loaded')
    expect(CRDT_EVENTS.DOC_ERROR).toBe('crdt:doc-error')
  })

  it('pins the Y.Doc fragment name', () => {
    expect(CRDT_FRAGMENT_NAME).toBe('prosemirror')
  })
})

describe('CrdtOpenDocSchema / CrdtCloseDocSchema', () => {
  it('accepts a noteId', () => {
    expect(CrdtOpenDocSchema.safeParse({ noteId: 'note-1' }).success).toBe(true)
    expect(CrdtCloseDocSchema.safeParse({ noteId: 'note-1' }).success).toBe(true)
  })

  it('rejects empty noteId', () => {
    const result = CrdtOpenDocSchema.safeParse({ noteId: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('noteId')
    }
  })

  it('rejects missing noteId', () => {
    expect(CrdtOpenDocSchema.safeParse({}).success).toBe(false)
    expect(CrdtCloseDocSchema.safeParse({}).success).toBe(false)
  })
})

describe('CrdtApplyUpdateSchema', () => {
  it('accepts serialized Uint8Array payload', () => {
    const update = Array.from(new Uint8Array([0, 127, 255]))
    expect(CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update }).success).toBe(true)
  })

  it('accepts empty update array', () => {
    expect(
      CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update: [] }).success
    ).toBe(true)
  })

  it('rejects byte above 255', () => {
    const result = CrdtApplyUpdateSchema.safeParse({
      noteId: 'note-1',
      update: [256]
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe('update')
    }
  })

  it('rejects negative byte', () => {
    expect(
      CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update: [-1] }).success
    ).toBe(false)
  })

  it('rejects non-integer byte', () => {
    expect(
      CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update: [1.5] }).success
    ).toBe(false)
  })

  it('rejects missing noteId', () => {
    expect(CrdtApplyUpdateSchema.safeParse({ update: [0] }).success).toBe(false)
  })
})

describe('CrdtSyncStep1Schema', () => {
  it('accepts state vector bytes', () => {
    expect(
      CrdtSyncStep1Schema.safeParse({ noteId: 'note-1', stateVector: [0, 1, 2] }).success
    ).toBe(true)
  })

  it('rejects non-array stateVector', () => {
    const result = CrdtSyncStep1Schema.safeParse({
      noteId: 'note-1',
      stateVector: 'deadbeef'
    })
    expect(result.success).toBe(false)
  })

  it('rejects byte out of range', () => {
    expect(
      CrdtSyncStep1Schema.safeParse({ noteId: 'note-1', stateVector: [999] }).success
    ).toBe(false)
  })
})

describe('CrdtSyncStep2Schema', () => {
  it('accepts diff bytes', () => {
    expect(
      CrdtSyncStep2Schema.safeParse({ noteId: 'note-1', diff: [0, 10, 255] }).success
    ).toBe(true)
  })

  it('rejects missing diff', () => {
    expect(CrdtSyncStep2Schema.safeParse({ noteId: 'note-1' }).success).toBe(false)
  })

  it('rejects diff byte out of range', () => {
    expect(
      CrdtSyncStep2Schema.safeParse({ noteId: 'note-1', diff: [-1] }).success
    ).toBe(false)
  })
})
