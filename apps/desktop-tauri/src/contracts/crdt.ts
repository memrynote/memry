export const CRDT_FRAGMENT_NAME = 'prosemirror' as const

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
