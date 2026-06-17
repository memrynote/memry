import type { ArticleCapture } from '@memry/article-extract'
import type { ConnectionState } from './messages'

export type Phase =
  | 'extracting'
  | 'app-closed'
  | 'ready'
  | 'approving'
  | 'saving'
  | 'saved'
  | 'error'

export interface PopupState {
  draft: ArticleCapture | null
  draftReady: boolean
  connection: 'unknown' | ConnectionState
  port: number | null
  action: 'idle' | 'approving' | 'saving' | 'saved' | 'error'
  itemId: string | null
  errorMessage: string | null
}

export type PopupAction =
  | { type: 'DRAFT_READY'; draft: ArticleCapture | null }
  | { type: 'STATUS'; connection: ConnectionState; port: number | null }
  | { type: 'EDIT'; draft: ArticleCapture }
  | { type: 'APPROVE_START' }
  | { type: 'APPROVE_DONE'; ok: boolean }
  | { type: 'SAVE_START' }
  | { type: 'SAVE_DONE'; result: { ok: true; itemId: string } | { ok: false; error: string } }
  | { type: 'RETRY' }

export const initialState: PopupState = {
  draft: null,
  draftReady: false,
  connection: 'unknown',
  port: null,
  action: 'idle',
  itemId: null,
  errorMessage: null
}

export function mapError(code: string): string {
  switch (code) {
    case 'bad-token':
    case 'origin-not-allowed':
      return 'Pairing expired — pair with Memry again.'
    case 'invalid-capture':
      return "Memry couldn't read this capture."
    case 'payload-too-large':
      return 'This page is too large to capture.'
    case 'pair-timeout':
      return 'Pairing timed out. Try again.'
    default:
      return "Couldn't reach Memry. Try again."
  }
}

export function reducer(state: PopupState, action: PopupAction): PopupState {
  switch (action.type) {
    case 'DRAFT_READY':
      return { ...state, draft: action.draft, draftReady: true }
    case 'STATUS':
      return { ...state, connection: action.connection, port: action.port }
    case 'EDIT':
      return { ...state, draft: action.draft }
    case 'APPROVE_START':
      return { ...state, action: 'approving', errorMessage: null }
    case 'APPROVE_DONE':
      return action.ok
        ? { ...state, action: 'idle' }
        : {
            ...state,
            action: 'error',
            errorMessage: 'Approve the Memry extension, then try again.'
          }
    case 'SAVE_START':
      return { ...state, action: 'saving', errorMessage: null }
    case 'SAVE_DONE':
      return action.result.ok
        ? { ...state, action: 'saved', itemId: action.result.itemId }
        : { ...state, action: 'error', errorMessage: mapError(action.result.error) }
    case 'RETRY':
      return { ...state, action: 'idle', errorMessage: null }
    default:
      return state
  }
}

export function selectPhase(state: PopupState): Phase {
  if (state.action === 'saved') return 'saved'
  if (state.action === 'error') return 'error'
  if (state.action === 'saving') return 'saving'
  if (state.action === 'approving') return 'approving'
  if (state.connection === 'unknown' || !state.draftReady) return 'extracting'
  if (state.connection === 'app-closed') return 'app-closed'
  return 'ready' // 'ready' and 'needs-pairing' both render the editable miniature
}
