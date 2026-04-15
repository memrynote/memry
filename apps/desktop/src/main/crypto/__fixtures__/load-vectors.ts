// Golden-vector loader helpers for crypto fixtures.
//
// Each `assert*Vector` runs at module-import time so that corrupted or
// accidentally-edited vectors fail fast at fixture load, not deep inside
// crypto code. Provenance metadata (`name`, `source`, `retrievedAt`) lives
// on every vector; SHA-256 sentinels for expected outputs are stored as
// comments next to the literals (see ./README.md regen recipe).

export interface XChaCha20Vector {
  readonly name: string
  readonly source: string
  readonly retrievedAt: string
  readonly key: Uint8Array
  readonly nonce: Uint8Array
  readonly aad: Uint8Array
  readonly plaintext: Uint8Array
  readonly ciphertext: Uint8Array
  readonly tag: Uint8Array
}

export interface Ed25519Vector {
  readonly name: string
  readonly source: string
  readonly retrievedAt: string
  readonly secretKeySeed: Uint8Array
  readonly publicKey: Uint8Array
  readonly message: Uint8Array
  readonly signature: Uint8Array
}

export interface Argon2idVector {
  readonly name: string
  readonly source: string
  readonly retrievedAt: string
  readonly password: Uint8Array
  readonly salt: Uint8Array
  readonly secret: Uint8Array
  readonly associatedData: Uint8Array
  readonly parallelism: number
  readonly tagLength: number
  readonly memoryKiB: number
  readonly iterations: number
  readonly version: number
  readonly tag: Uint8Array
}

const failShape = (vectorName: string, fieldName: string, detail: string): never => {
  throw new Error(
    `Invalid vector "${vectorName}" — field "${fieldName}" failed shape check: ${detail}`
  )
}

const requireBytes = (vectorName: string, fieldName: string, value: unknown): void => {
  if (!(value instanceof Uint8Array)) {
    failShape(vectorName, fieldName, 'expected Uint8Array')
  }
}

const requireFixedBytes = (
  vectorName: string,
  fieldName: string,
  value: unknown,
  expectedLength: number
): void => {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    failShape(vectorName, fieldName, `expected ${expectedLength}-byte Uint8Array`)
  }
}

const requirePositiveInt = (vectorName: string, fieldName: string, value: number): void => {
  if (!Number.isInteger(value) || value <= 0) {
    failShape(vectorName, fieldName, 'expected positive integer')
  }
}

export const assertXChaCha20Vector = (vector: XChaCha20Vector): XChaCha20Vector => {
  requireFixedBytes(vector.name, 'key', vector.key, 32)
  requireFixedBytes(vector.name, 'nonce', vector.nonce, 24)
  requireBytes(vector.name, 'aad', vector.aad)
  requireBytes(vector.name, 'plaintext', vector.plaintext)
  requireFixedBytes(vector.name, 'ciphertext', vector.ciphertext, vector.plaintext.length)
  requireFixedBytes(vector.name, 'tag', vector.tag, 16)
  return vector
}

export const assertEd25519Vector = (vector: Ed25519Vector): Ed25519Vector => {
  requireFixedBytes(vector.name, 'secretKeySeed', vector.secretKeySeed, 32)
  requireFixedBytes(vector.name, 'publicKey', vector.publicKey, 32)
  requireBytes(vector.name, 'message', vector.message)
  requireFixedBytes(vector.name, 'signature', vector.signature, 64)
  return vector
}

export const assertArgon2idVector = (vector: Argon2idVector): Argon2idVector => {
  requireBytes(vector.name, 'password', vector.password)
  requireBytes(vector.name, 'salt', vector.salt)
  requireBytes(vector.name, 'secret', vector.secret)
  requireBytes(vector.name, 'associatedData', vector.associatedData)
  requirePositiveInt(vector.name, 'parallelism', vector.parallelism)
  requirePositiveInt(vector.name, 'tagLength', vector.tagLength)
  requirePositiveInt(vector.name, 'memoryKiB', vector.memoryKiB)
  requirePositiveInt(vector.name, 'iterations', vector.iterations)
  requirePositiveInt(vector.name, 'version', vector.version)
  requireFixedBytes(vector.name, 'tag', vector.tag, vector.tagLength)
  return vector
}

// Vector files invoke `hexToBytes` at module-evaluation time, before any
// `await sodium.ready` has had a chance to run. We therefore avoid
// libsodium's `from_hex` here so fixtures stay synchronously importable.
export const hexToBytes = (hex: string): Uint8Array => {
  const stripped = hex.replace(/\s+/g, '')
  if (stripped.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${stripped.length} chars)`)
  }
  if (!/^[0-9a-f]*$/i.test(stripped)) {
    throw new Error('hexToBytes: input contains non-hex characters')
  }
  const out = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
