import { compactVerify, decodeProtectedHeader } from 'jose'

import { APPLE_ROOT_CA_G3_DER } from './apple-root-ca'

/**
 * Verifies an App Store signed JWS (transaction, renewal info, or notification payload).
 *
 * Apple signs with ES256 and ships the chain in the `x5c` header: leaf, intermediate, root. The
 * chain is checked against the pinned Apple Root CA - G3, never against the root in the header:
 * the intermediate must be signed by the pinned root, the leaf by the intermediate, each must
 * carry Apple's marker OID, and all three must be valid at the payload's `signedDate`.
 *
 * Xcode (StoreKit testing) transactions are signed by a local certificate and always fail here.
 */

export class AppleJwsError extends Error {}

const OID_LEAF_MARKER = '1.2.840.113635.100.6.11.1'
const OID_INTERMEDIATE_MARKER = '1.2.840.113635.100.6.2.1'
const SIGNATURE_HASH: Record<string, 'SHA-256' | 'SHA-384'> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384'
}
const CURVES: Record<string, { name: 'P-256' | 'P-384'; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 }
}

export async function verifyAppleJws<T extends { signedDate?: number }>(jws: string): Promise<T> {
  let x5c: unknown
  try {
    x5c = decodeProtectedHeader(jws).x5c
  } catch {
    throw new AppleJwsError('Malformed JWS')
  }
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every((c) => typeof c === 'string')) {
    throw new AppleJwsError('JWS has no certificate chain')
  }

  const root = parseCertificate(APPLE_ROOT_CA_G3_DER)
  const intermediate = parseCertificate(base64ToBytes(x5c[1]))
  const leaf = parseCertificate(base64ToBytes(x5c[0]))

  if (!intermediate.extensionOids.includes(OID_INTERMEDIATE_MARKER)) {
    throw new AppleJwsError('Intermediate certificate is not an Apple App Store intermediate')
  }
  if (!leaf.extensionOids.includes(OID_LEAF_MARKER)) {
    throw new AppleJwsError('Leaf certificate is not an Apple App Store signing certificate')
  }
  if (!(await verifyCertificateSignature(intermediate, root))) {
    throw new AppleJwsError('Intermediate certificate is not signed by Apple Root CA - G3')
  }
  if (!(await verifyCertificateSignature(leaf, intermediate))) {
    throw new AppleJwsError('Leaf certificate is not signed by the intermediate')
  }

  let payload: T
  try {
    const leafKey = await importSpki(leaf, 'P-256')
    const verified = await compactVerify(jws, leafKey, { algorithms: ['ES256'] })
    payload = JSON.parse(new TextDecoder().decode(verified.payload)) as T
  } catch {
    throw new AppleJwsError('JWS signature is invalid')
  }

  const signedDate = payload.signedDate
  if (typeof signedDate !== 'number') {
    throw new AppleJwsError('JWS payload has no signedDate')
  }
  for (const cert of [leaf, intermediate, root]) {
    if (signedDate < cert.notBefore || signedDate > cert.notAfter) {
      throw new AppleJwsError('Certificate was not valid at signedDate')
    }
  }
  return payload
}

// ---------------------------------------------------------------------------
// Minimal DER / X.509 reader: only the fields the checks above use.
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number
  start: number
  contentStart: number
  end: number
}

interface Certificate {
  tbs: Uint8Array
  signatureHash: 'SHA-256' | 'SHA-384'
  signature: Uint8Array
  spki: Uint8Array
  curve: { name: 'P-256' | 'P-384'; size: number }
  notBefore: number
  notAfter: number
  extensionOids: string[]
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset + 2 > bytes.length) throw new AppleJwsError('Truncated certificate')
  const tag = bytes[offset]
  let length = bytes[offset + 1]
  let contentStart = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4) throw new AppleJwsError('Unsupported DER length')
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[contentStart + i]
    contentStart += count
  }
  const end = contentStart + length
  if (end > bytes.length) throw new AppleJwsError('Truncated certificate')
  return { tag, start: offset, contentStart, end }
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const result: Tlv[] = []
  for (let offset = parent.contentStart; offset < parent.end;) {
    const tlv = readTlv(bytes, offset)
    result.push(tlv)
    offset = tlv.end
  }
  return result
}

function expectTag(tlv: Tlv | undefined, tag: number): Tlv {
  if (!tlv || tlv.tag !== tag) throw new AppleJwsError('Unexpected certificate structure')
  return tlv
}

function decodeOid(bytes: Uint8Array, tlv: Tlv): string {
  const parts: number[] = []
  let value = 0
  for (let i = tlv.contentStart; i < tlv.end; i += 1) {
    value = value * 128 + (bytes[i] & 0x7f)
    if (!(bytes[i] & 0x80)) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2
        parts.push(first, value - first * 40)
      } else {
        parts.push(value)
      }
      value = 0
    }
  }
  return parts.join('.')
}

function decodeTime(bytes: Uint8Array, tlv: Tlv): number {
  const text = new TextDecoder().decode(bytes.subarray(tlv.contentStart, tlv.end))
  const match =
    tlv.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
  if (!match) throw new AppleJwsError('Unsupported certificate time')
  let year = Number(match[1])
  if (tlv.tag === 0x17) year += year >= 50 ? 1900 : 2000
  return Date.UTC(
    year,
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  )
}

function parseCertificate(der: Uint8Array): Certificate {
  const cert = expectTag(readTlv(der, 0), 0x30)
  const [tbsTlv, sigAlgTlv, sigTlv] = children(der, cert)
  const tbs = expectTag(tbsTlv, 0x30)
  const signatureHash =
    SIGNATURE_HASH[decodeOid(der, expectTag(children(der, expectTag(sigAlgTlv, 0x30))[0], 0x06))]
  if (!signatureHash) throw new AppleJwsError('Unsupported certificate signature algorithm')
  const signatureBits = expectTag(sigTlv, 0x03)

  const fields = children(der, tbs)
  // version [0] is optional, so locate the rest relative to it.
  const base = fields[0]?.tag === 0xa0 ? 1 : 0
  const validity = children(der, expectTag(fields[base + 3], 0x30))
  const spkiTlv = expectTag(fields[base + 5], 0x30)
  const spkiAlg = children(der, expectTag(children(der, spkiTlv)[0], 0x30))
  const curve = CURVES[decodeOid(der, expectTag(spkiAlg[1], 0x06))]
  if (!curve) throw new AppleJwsError('Unsupported certificate key')

  const extensionOids: string[] = []
  const extensionsWrapper = fields.slice(base + 6).find((field) => field.tag === 0xa3)
  if (extensionsWrapper) {
    const list = expectTag(children(der, extensionsWrapper)[0], 0x30)
    for (const extension of children(der, list)) {
      extensionOids.push(decodeOid(der, expectTag(children(der, extension)[0], 0x06)))
    }
  }

  return {
    tbs: der.slice(tbs.start, tbs.end),
    signatureHash,
    // BIT STRING content starts with the unused-bits byte.
    signature: der.slice(signatureBits.contentStart + 1, signatureBits.end),
    spki: der.slice(spkiTlv.start, spkiTlv.end),
    curve,
    notBefore: decodeTime(der, validity[0]),
    notAfter: decodeTime(der, validity[1]),
    extensionOids
  }
}

async function importSpki(cert: Certificate, expected?: 'P-256' | 'P-384'): Promise<CryptoKey> {
  if (expected && cert.curve.name !== expected) {
    throw new AppleJwsError('Unexpected signing key curve')
  }
  return crypto.subtle.importKey(
    'spki',
    cert.spki,
    { name: 'ECDSA', namedCurve: cert.curve.name },
    false,
    ['verify']
  )
}

async function verifyCertificateSignature(
  cert: Certificate,
  issuer: Certificate
): Promise<boolean> {
  const key = await importSpki(issuer)
  const signature = derSignatureToRaw(cert.signature, issuer.curve.size)
  return crypto.subtle.verify({ name: 'ECDSA', hash: cert.signatureHash }, key, signature, cert.tbs)
}

/** X.509 carries ECDSA-Sig-Value (DER SEQUENCE of r, s). WebCrypto wants r || s. */
function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const seq = expectTag(readTlv(der, 0), 0x30)
  const [r, s] = children(der, seq)
  const out = new Uint8Array(size * 2)
  for (const [index, tlv] of [r, s].entries()) {
    let value = der.subarray(expectTag(tlv, 0x02).contentStart, tlv.end)
    while (value.length > size && value[0] === 0) value = value.subarray(1)
    if (value.length > size) throw new AppleJwsError('Invalid certificate signature')
    out.set(value, index * size + (size - value.length))
  }
  return out
}

function base64ToBytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    throw new AppleJwsError('Invalid certificate encoding')
  }
}
