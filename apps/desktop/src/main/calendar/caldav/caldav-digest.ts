import { createHash, randomBytes } from 'node:crypto'

/**
 * HTTP Digest authentication (RFC 7616, with RFC 2617 MD5 compatibility).
 * `tsdav`'s "Digest" mode only sends a caller-computed header; it does not
 * answer a server challenge. Some self-hosted CalDAV servers (older Baïkal,
 * some Radicale set-ups) only offer Digest, so the transport answers the
 * challenge here.
 */

export interface DigestChallenge {
  realm: string
  nonce: string
  qop: string | null
  opaque: string | null
  algorithm: 'MD5' | 'SHA-256'
}

/** Parse `WWW-Authenticate: Digest ...`; null when the header offers no Digest. */
export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header) return null
  const match = /Digest\s+(.*)$/i.exec(header)
  if (!match) return null
  const params = new Map<string, string>()
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/gi
  for (let part = pattern.exec(match[1]); part; part = pattern.exec(match[1])) {
    params.set(part[1].toLowerCase(), part[2] ?? part[3] ?? '')
  }
  const realm = params.get('realm')
  const nonce = params.get('nonce')
  if (realm === undefined || !nonce) return null
  const qops = (params.get('qop') ?? '').split(',').map((value) => value.trim())
  const algorithm = (params.get('algorithm') ?? 'MD5').toUpperCase()
  if (algorithm !== 'MD5' && algorithm !== 'SHA-256') return null
  return {
    realm,
    nonce,
    qop: qops.includes('auth') ? 'auth' : null,
    opaque: params.get('opaque') ?? null,
    algorithm
  }
}

function hash(algorithm: DigestChallenge['algorithm'], value: string): string {
  return createHash(algorithm === 'MD5' ? 'md5' : 'sha256')
    .update(value)
    .digest('hex')
}

/** The `Authorization` header answering one challenge for one request. */
export function digestAuthorization(input: {
  challenge: DigestChallenge
  username: string
  password: string
  method: string
  uri: string
  nonceCount: number
  cnonce?: string
}): string {
  const { challenge, username, password, method, uri, nonceCount } = input
  const cnonce = input.cnonce ?? randomBytes(8).toString('hex')
  const nc = nonceCount.toString(16).padStart(8, '0')
  const ha1 = hash(challenge.algorithm, `${username}:${challenge.realm}:${password}`)
  const ha2 = hash(challenge.algorithm, `${method}:${uri}`)
  const response = challenge.qop
    ? hash(challenge.algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : hash(challenge.algorithm, `${ha1}:${challenge.nonce}:${ha2}`)

  const parts = [
    `username="${username.replace(/"/g, '\\"')}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`
  ]
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (challenge.opaque !== null) parts.push(`opaque="${challenge.opaque}"`)
  return `Digest ${parts.join(', ')}`
}
