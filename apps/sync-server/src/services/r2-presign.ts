import type { Bindings } from '../types'

/**
 * Zero-dependency AWS SigV4 query-string presigner for the R2 S3 API.
 *
 * R2 speaks the S3 protocol on `https://<account>.r2.cloudflarestorage.com`,
 * so a presigned URL is a plain SigV4 presign with region `auto`, service
 * `s3` and payload hash `UNSIGNED-PAYLOAD`. Hand-rolling this (~100 lines on
 * Web Crypto, which Workers and Node 18+ both provide) beats pulling
 * aws4fetch/aws-sdk: no dependency to audit for one HMAC chain, and the
 * signature path is fully unit-testable against AWS's published known-answer
 * vector (see r2-presign.test.ts).
 *
 * Two layers on purpose:
 * - `presignS3Url` is the pure protocol (no policy), pinned byte-for-byte by
 *   the AWS published vector.
 * - `presignR2Url` is the deployment policy wrapper: it derives the path-style
 *   R2 address, clamps TTLs to minutes-scale, and defaults region `auto`.
 *
 * Security posture: a leaked URL exposes only E2E-encrypted ciphertext, but
 * TTLs are still clamped (MAX_PRESIGN_TTL_SECONDS) and keys are derived
 * SERVER-SIDE from D1 rows scoped by user + vault — clients only ever send
 * chunk hashes, never key material, so cross-vault scope escapes are
 * structurally impossible (see assertPresignKeyInVault, applied before signing).
 */

export const DEFAULT_PRESIGN_TTL_SECONDS = 300
export const MAX_PRESIGN_TTL_SECONDS = 300

const SERVICE = 's3'
const ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export interface R2PresignConfig {
  accessKeyId: string
  secretAccessKey: string
  /** S3 endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  bucket: string
}

/**
 * Resolve the presign credential set from Worker bindings. Any missing piece
 * means this deployment has not opted into direct R2 transfers: callers must
 * degrade gracefully to the proxied blob paths (the production-beta contract),
 * never fail.
 */
export const resolveR2PresignConfig = (
  env: Pick<
    Bindings,
    'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_S3_ENDPOINT' | 'R2_S3_BUCKET'
  >
): R2PresignConfig | null => {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_S3_BUCKET } = env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT || !R2_S3_BUCKET) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(R2_S3_ENDPOINT)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.host) return null
  return {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    // Normalize: a trailing slash would double up in the canonical path.
    endpoint: `${parsed.protocol}//${parsed.host}`,
    bucket: R2_S3_BUCKET
  }
}

/**
 * Defense in depth over the structural scope guarantee: every key handed to
 * the presigner must sit under the authenticated user's vault prefix. Chunk
 * keys already derive from scoped D1 rows, but presigned URLs bypass every
 * other auth check, so the prefix assertion runs immediately before signing.
 */
export const assertPresignKeyInVault = (key: string, userId: string, vaultId: string): void => {
  if (!key.startsWith(`${userId}/vaults/${vaultId}/`)) {
    throw new Error(`presign key outside vault scope: ${key}`)
  }
}

// ---------------------------------------------------------------------------
// SigV4 primitives (Web Crypto — available in Workers and Node >= 18)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const sha256Hex = async (data: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return toHex(new Uint8Array(digest))
}

const hmac = async (key: Uint8Array, data: string): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

/** RFC 3986 strict encoding: unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~". */
const uriEncode = (value: string, encodeSlash: boolean): string => {
  const bytes = encoder.encode(value)
  let out = ''
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch
    } else if (ch === '/' && !encodeSlash) {
      out += '/'
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Path-encode an object key, preserving `/` separators. */
const encodeObjectKey = (key: string): string => uriEncode(key, false)

const amzDateFormat = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

// ---------------------------------------------------------------------------
// Protocol layer — pure SigV4 presign, no deployment policy
// ---------------------------------------------------------------------------

export interface S3PresignInput {
  host: string
  method: 'GET' | 'PUT'
  /**
   * Canonical object path INCLUDING any bucket prefix, e.g. `/bucket/key`
   * (path-style) or `/key` (virtual-hosted). Slashes stay literal; everything
   * else must already be RFC 3986-encoded.
   */
  objectPath: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  expiresInSeconds: number
  now?: Date
}

/**
 * Presign one S3 object URL. Pure protocol: no TTL ceiling, no scope checks —
 * callers own the policy (that separation is what lets the AWS published
 * known-answer vector pin this function byte-for-byte).
 */
export const presignS3Url = async (input: S3PresignInput): Promise<string> => {
  const now = input.now ?? new Date()
  const amzDate = amzDateFormat(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ]
  // Canonical query string: sorted by key name, fully URI-encoded values.
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalRequest = [
    input.method,
    input.objectPath,
    canonicalQuery,
    `host:${input.host}`,
    '',
    'host',
    UNSIGNED_PAYLOAD
  ].join('\n')

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n')

  // kSigning = HMAC(HMAC(HMAC(HMAC(kSecret="AWS4"+secret, date), region), service), "aws4_request")
  const kDate = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), dateStamp)
  const kRegion = await hmac(kDate, input.region)
  const kService = await hmac(kRegion, SERVICE)
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = toHex(await hmac(kSigning, stringToSign))

  return `https://${input.host}${input.objectPath}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

// ---------------------------------------------------------------------------
// R2 policy layer — path-style addressing + minutes-scale TTL ceiling
// ---------------------------------------------------------------------------

/**
 * Presign one R2 object URL with the deployment TTL policy applied. `now` and
 * `region` are injectable so tests can reproduce fixed-date vectors.
 */
export const presignR2Url = async (
  config: R2PresignConfig,
  options: {
    method: 'GET' | 'PUT'
    key: string
    expiresInSeconds?: number
    now?: Date
    /** R2 signs with region `auto`; override only for known-answer tests. */
    region?: string
  }
): Promise<string> => {
  const expiresInSeconds = Math.min(
    Math.max(Math.floor(options.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS), 1),
    MAX_PRESIGN_TTL_SECONDS
  )

  return presignS3Url({
    host: new URL(config.endpoint).host,
    method: options.method,
    objectPath: `/${encodeObjectKey(config.bucket)}/${encodeObjectKey(options.key)}`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: options.region ?? 'auto',
    expiresInSeconds,
    ...(options.now ? { now: options.now } : {})
  })
}
