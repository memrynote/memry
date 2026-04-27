import type {
  CrdtApplyUpdateInput,
  CrdtApplyUpdateResult,
  CrdtChunkAppendInput,
  CrdtChunkFinishInput,
  CrdtChunkStartInput,
  CrdtGetOrInitDocResult,
  CrdtSimpleSuccess,
  SyncStep1Result
} from '@/generated/bindings'

export const CRDT_FRAGMENT_NAME = 'prosemirror' as const

export interface CrdtOpenDocInput {
  noteId: string
}

export type CrdtOpenDocResult = CrdtSimpleSuccess

export interface CrdtCloseDocInput {
  noteId: string
}

export interface CrdtSyncStep1Input {
  noteId: string
  stateVector: number[]
}

export interface CrdtSyncStep2Input {
  noteId: string
  diff: number[]
}

export interface CrdtUpdateEvent {
  noteId: string
  update: number[]
  origin: number
}

export type {
  CrdtApplyUpdateInput,
  CrdtApplyUpdateResult,
  CrdtChunkAppendInput,
  CrdtChunkFinishInput,
  CrdtChunkStartInput,
  CrdtGetOrInitDocResult,
  CrdtSimpleSuccess,
  SyncStep1Result
}
