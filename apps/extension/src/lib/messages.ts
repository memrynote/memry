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

export type CaptureMode = 'article' | 'selection' | 'screenshot' | 'pdf'

export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }
  | { type: 'WAIT_FOR_SERVER' }
  | { type: 'GRAB_SCREENSHOT' }
  | { type: 'FETCH_PDF'; url: string }
  | { type: 'FLUSH_QUEUE' }
  | { type: 'REVOKE' }

export type ContentMessage =
  | { type: 'EXTRACT' }
  | { type: 'GRAB_SELECTION' }
  | { type: 'GET_PAGE_METRICS' }
  | { type: 'SCROLL_TO'; y: number }

export type ExtractResponse = { ok: true; capture: ArticleCapture } | { ok: false; error: string }

export interface PageMetrics {
  scrollHeight: number
  innerHeight: number
  innerWidth: number
  dpr: number
  scrollY: number
}

export type ScreenshotResponse = { ok: true; dataUrl: string } | { ok: false; error: string }

export type FetchPdfResponse =
  | { ok: true; dataUrl: string; filename: string }
  | { ok: false; error: string }

export interface FlushResponse {
  flushed: number
  remaining: number
}
