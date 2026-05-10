import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface McpSessionContext {
  conversationId: string | null
  windowId: string | null
}

export interface McpSession {
  readonly token: string
  rotateToken(): string
  verifyToken(candidate: string | undefined): boolean
  contextFromHeaders(headers: Record<string, string | string[] | undefined>): McpSessionContext
}

function mintToken(): string {
  return randomBytes(32).toString('hex')
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const lower = name.toLowerCase()
  const raw = headers[lower] ?? headers[name]
  if (!raw) return null
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

export function createMcpSession(): McpSession {
  let bearer = mintToken()
  return {
    get token() {
      return bearer
    },
    rotateToken() {
      bearer = mintToken()
      return bearer
    },
    verifyToken(candidate) {
      if (!candidate) return false
      const a = Buffer.from(candidate, 'utf8')
      const b = Buffer.from(bearer, 'utf8')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    },
    contextFromHeaders(headers) {
      return {
        conversationId: readHeader(headers, 'x-memry-conversation'),
        windowId: readHeader(headers, 'x-memry-window')
      }
    }
  }
}
