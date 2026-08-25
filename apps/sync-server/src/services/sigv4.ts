/**
 * Pure AWS SigV4 query-string presign — the protocol layer under r2-presign.
 *
 * Zero dependencies, zero policy: no TTL ceiling, no scope checks, no R2
 * addressing rules. It exists as its own module so that the deployment-facing
 * surface (services/r2-presign.ts) exports ONLY the policy wrapper
 * `presignR2Url` — callers physically cannot bypass the TTL clamp or vault
 * prefix rules by importing the raw signer — while this layer stays pinned
 * byte-for-byte against AWS's published known-answer vector (sigv4 tests live
 * alongside r2-presign's in r2-presign.test.ts).
 */

const SERVICE = 's3'
const ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

const encoder = new TextEncoder()

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
export const encodeObjectKey = (key: string): string => uriEncode(key, false)

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

const amzDateFormat = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

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
