import { timingSafeEqual } from 'node:crypto'

export interface CaptureAuthHeaders {
  authorization?: string
  origin?: string
  'x-memry-capture'?: string
}

type Result = { ok: true } | { ok: false; reason: string }

function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function validateCaptureRequest(
  headers: CaptureAuthHeaders,
  token: string,
  originAllowed: (o: string | undefined) => boolean
): Result {
  if (headers['x-memry-capture'] !== '1') return { ok: false, reason: 'missing-capture-header' }
  if (!originAllowed(headers.origin)) return { ok: false, reason: 'origin-not-allowed' }
  const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : ''
  if (!bearer || !tokenEquals(bearer, token)) return { ok: false, reason: 'bad-token' }
  return { ok: true }
}
