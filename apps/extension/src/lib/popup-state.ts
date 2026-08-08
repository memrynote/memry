import type { ArticleCapture } from '@memry/article-extract'
import type { CaptureMode, ConnectionState } from './messages'

export type Phase =
  | 'extracting'
  | 'capturing'
  | 'app-closed'
  | 'launching'
  | 'ready'
  | 'approving'
  | 'saving'
  | 'saved'
  | 'queued'
  | 'error'

export interface PopupState {
  draft: ArticleCapture | null
  draftReady: boolean
  mode: CaptureMode
  capturing: boolean
  connection: 'unknown' | ConnectionState
  port: number | null
  action: 'idle' | 'launching' | 'approving' | 'saving' | 'saved' | 'queued' | 'error'
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
  | { type: 'LAUNCH_START' }
  | { type: 'LAUNCH_DONE'; ok: boolean }
  | { type: 'RETRY' }
  | { type: 'SET_MODE'; mode: CaptureMode }

export const initialState: PopupState = {
  draft: null,
  draftReady: false,
  mode: 'article',
  capturing: false,
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
    case 'permission-denied':
      return 'Allow the access Memry asked for, then save again.'
    case 'pdf-fetch-failed':
      return "Couldn't download this PDF. Open it directly, then try again."
    case 'not-a-pdf':
      return "This isn't a PDF — nothing to save."
    case 'pdf-too-large':
      return 'This PDF is too large to clip (limit 16 MB).'
    default:
      return "Couldn't reach Memry. Try again."
  }
}

export function reducer(state: PopupState, action: PopupAction): PopupState {
  switch (action.type) {
    case 'DRAFT_READY':
      return { ...state, draft: action.draft, draftReady: true, capturing: false }
    case 'SET_MODE':
      return {
        ...state,
        mode: action.mode,
        capturing: action.mode !== 'article',
        draftReady: false,
        errorMessage: null
      }
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
      if (action.result.ok) {
        return { ...state, action: 'saved', itemId: action.result.itemId }
      }
      if (action.result.error === 'queued') {
        return { ...state, action: 'queued', errorMessage: null }
      }
      return { ...state, action: 'error', errorMessage: mapError(action.result.error) }
    case 'LAUNCH_START':
      return { ...state, action: 'launching', errorMessage: null }
    case 'LAUNCH_DONE':
      return action.ok
        ? { ...state, action: 'idle' }
        : { ...state, action: 'error', errorMessage: 'Open Memry, then try again.' }
    case 'RETRY':
      return { ...state, action: 'idle', errorMessage: null }
    default:
      return state
  }
}

export function selectPhase(state: PopupState): Phase {
  if (state.action === 'saved') return 'saved'
  if (state.action === 'queued') return 'queued'
  if (state.action === 'error') return 'error'
  if (state.action === 'saving') return 'saving'
  if (state.action === 'approving') return 'approving'
  if (state.action === 'launching') return 'launching'
  if (state.capturing) return 'capturing'
  if (state.connection === 'unknown' || !state.draftReady) return 'extracting'
  if (state.connection === 'app-closed') return 'app-closed'
  return 'ready' // 'ready' and 'needs-pairing' both render the editable miniature
}
