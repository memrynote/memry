import { z } from 'zod'

export const CRDT_CHANNELS = {
  OPEN_DOC: 'crdt:open-doc',
  CLOSE_DOC: 'crdt:close-doc',
  APPLY_UPDATE: 'crdt:apply-update',
  SYNC_STEP_1: 'crdt:sync-step-1',
  SYNC_STEP_2: 'crdt:sync-step-2'
} as const

export const CRDT_EVENTS = {
  STATE_CHANGED: 'crdt:state-changed',
  DOC_LOADED: 'crdt:doc-loaded',
  DOC_ERROR: 'crdt:doc-error'
} as const

export const CRDT_FRAGMENT_NAME = 'prosemirror' as const

export const CrdtOpenDocSchema = z.object({ noteId: z.string().min(1) })
export const CrdtCloseDocSchema = z.object({ noteId: z.string().min(1) })
export const CrdtApplyUpdateSchema = z.object({
  noteId: z.string().min(1),
  update: z.array(z.number().int().min(0).max(255))
})
export const CrdtSyncStep1Schema = z.object({
  noteId: z.string().min(1),
  stateVector: z.array(z.number().int().min(0).max(255))
})
export const CrdtSyncStep2Schema = z.object({
  noteId: z.string().min(1),
  diff: z.array(z.number().int().min(0).max(255))
})

export interface CrdtOpenDocInput {
  noteId: string
}

export interface CrdtOpenDocResult {
  success: boolean
  error?: string
}

export interface CrdtCloseDocInput {
  noteId: string
}

export interface CrdtApplyUpdateInput {
  noteId: string
  update: Uint8Array
}

export interface CrdtSyncStep1Input {
  noteId: string
  stateVector: Uint8Array
}

export interface CrdtSyncStep1Result {
  diff: Uint8Array
  stateVector: Uint8Array
}

export interface CrdtSyncStep2Input {
  noteId: string
  diff: Uint8Array
}

export interface CrdtStateChangedEvent {
  noteId: string
  update: Uint8Array
  origin: 'local' | 'ipc' | 'network'
}
