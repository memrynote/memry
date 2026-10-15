import { CompactSign } from 'jose'

/**
 * A self-signed stand-in for Apple's App Store signing chain: a P-384 root, a P-384 intermediate
 * carrying Apple's intermediate marker OID, and a P-256 leaf carrying the leaf marker OID. Tests
 * swap it in for Apple Root CA - G3 by mocking `lib/apple-root-ca`; production pinning is untouched.
 */

const LEAF_OID = '1.2.840.113635.100.6.11.1'
const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1'

/** Root the mocked `lib/apple-root-ca` serves. Tests assign `der` before verifying. */
export const trustedRoot: { der: Uint8Array } = { der: new Uint8Array() }

const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const header =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff]
  const out = new Uint8Array(header.length + length)
  out.set(header)
  let offset = header.length
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts)
const integer = (bytes: Uint8Array) => {
  let value = bytes
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1)
  return tlv(0x02, value[0] & 0x80 ? Uint8Array.of(0, ...value) : value)
}
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const bytes = [a * 40 + b]
  for (const part of rest) {
    const chunk = [part & 0x7f]
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Uint8Array.from(bytes))
}
const utcTime = (date: Date) => {
  const iso = date.toISOString()
  const text =
    iso.slice(2, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    'Z'
  return tlv(0x17, new TextEncoder().encode(text))
}
const name = (cn: string) =>
  seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, new TextEncoder().encode(cn)))))

const SHA384_ECDSA = seq(oid('1.2.840.10045.4.3.3'))

interface Issuer {
  name: string
  privateKey: CryptoKey
}

async function certificate(options: {
  subject: string
  publicKey: CryptoKey
  issuer: Issuer | null
  selfKey?: CryptoKey
  markerOid?: string
  notBefore: Date
  notAfter: Date
}): Promise<Uint8Array> {
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', options.publicKey)) as ArrayBuffer
  )
  const extensions = options.markerOid
    ? [tlv(0xa3, seq(seq(oid(options.markerOid), tlv(0x04, Uint8Array.of(0x05, 0x00)))))]
    : []
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(crypto.getRandomValues(new Uint8Array(8))),
    SHA384_ECDSA,
    name(options.issuer?.name ?? options.subject),
    seq(utcTime(options.notBefore), utcTime(options.notAfter)),
    name(options.subject),
    spki,
    ...extensions
  )
  const signer = options.issuer?.privateKey ?? options.selfKey!
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, signer, tbs)
  )
  const half = raw.length / 2
  const signature = seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)))
  return seq(tbs, SHA384_ECDSA, tlv(0x03, Uint8Array.of(0), signature))
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

export interface TestChain {
  rootDer: Uint8Array
  x5c: string[]
  leafKey: CryptoKey
}

export async function createTestChain(
  options: { leafMarker?: boolean; notAfter?: Date } = {}
): Promise<TestChain> {
  const ecdsa = (namedCurve: string) =>
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, [
      'sign',
      'verify'
    ]) as Promise<CryptoKeyPair>
  const [root, intermediate, leaf] = await Promise.all([
    ecdsa('P-384'),
    ecdsa('P-384'),
    ecdsa('P-256')
  ])
  const notBefore = new Date(Date.now() - 86_400_000)
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000)

  const rootDer = await certificate({
    subject: 'Test Root',
    publicKey: root.publicKey,
    issuer: null,
    selfKey: root.privateKey,
    notBefore,
    notAfter
  })
  const intermediateDer = await certificate({
    subject: 'Test Intermediate',
    publicKey: intermediate.publicKey,
    issuer: { name: 'Test Root', privateKey: root.privateKey },
    markerOid: INTERMEDIATE_OID,
    notBefore,
    notAfter
  })
  const leafDer = await certificate({
    subject: 'Test Leaf',
    publicKey: leaf.publicKey,
    issuer: { name: 'Test Intermediate', privateKey: intermediate.privateKey },
    markerOid: options.leafMarker === false ? undefined : LEAF_OID,
    notBefore,
    notAfter
  })

  return {
    rootDer,
    x5c: [leafDer, intermediateDer, rootDer].map(toBase64),
    leafKey: leaf.privateKey
  }
}

export async function signAppleJws(chain: TestChain, payload: unknown): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'ES256', x5c: chain.x5c })
    .sign(chain.leafKey)
}
