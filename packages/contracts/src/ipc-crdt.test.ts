/**
 * IPC CRDT Contract Tests
 *
 * Covers the Yjs IPC envelope validators. `update`/`stateVector`/`diff` cross
 * the IPC boundary as raw `Uint8Array` — Electron's structured clone carries
 * binary natively, so the schemas must not force a boxed `number[]` copy.
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
  it('accepts a Uint8Array payload and hands it through untouched', () => {
    const update = new Uint8Array([0, 127, 255])
    const result = CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.update).toBeInstanceOf(Uint8Array)
      expect(result.data.update).toBe(update)
    }
  })

  it('accepts an empty update', () => {
    expect(
      CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update: new Uint8Array() }).success
    ).toBe(true)
  })

  it('rejects a boxed number[] payload', () => {
    const result = CrdtApplyUpdateSchema.safeParse({ noteId: 'note-1', update: [0, 127, 255] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe('update')
    }
  })

  it('rejects missing noteId', () => {
    expect(CrdtApplyUpdateSchema.safeParse({ update: new Uint8Array([0]) }).success).toBe(false)
  })
})

describe('CrdtSyncStep1Schema', () => {
  it('accepts a Uint8Array state vector', () => {
    const stateVector = new Uint8Array([0, 1, 2])
    const result = CrdtSyncStep1Schema.safeParse({ noteId: 'note-1', stateVector })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.stateVector).toBe(stateVector)
    }
  })

  it('rejects a non-binary stateVector', () => {
    expect(
      CrdtSyncStep1Schema.safeParse({ noteId: 'note-1', stateVector: 'deadbeef' }).success
    ).toBe(false)
    expect(
      CrdtSyncStep1Schema.safeParse({ noteId: 'note-1', stateVector: [0, 1, 2] }).success
    ).toBe(false)
  })
})

describe('CrdtSyncStep2Schema', () => {
  it('accepts a Uint8Array diff', () => {
    const diff = new Uint8Array([0, 10, 255])
    const result = CrdtSyncStep2Schema.safeParse({ noteId: 'note-1', diff })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.diff).toBe(diff)
    }
  })

  it('rejects missing diff', () => {
    expect(CrdtSyncStep2Schema.safeParse({ noteId: 'note-1' }).success).toBe(false)
  })

  it('rejects a boxed number[] diff', () => {
    expect(CrdtSyncStep2Schema.safeParse({ noteId: 'note-1', diff: [0, 10, 255] }).success).toBe(
      false
    )
  })
})
