import type { ArticleCapture } from '@memry/article-extract'

export type ConnectionState = 'app-closed' | 'needs-pairing' | 'ready'

export interface StatusResponse {
  connection: ConnectionState
  port: number | null
}

export interface PairResponse {
  ok: boolean
}

export type CaptureResponse = { ok: true; itemId: string } | { ok: false; error: string }

export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }

export type ContentMessage = { type: 'EXTRACT' }

export type ExtractResponse = { ok: true; capture: ArticleCapture } | { ok: false; error: string }
