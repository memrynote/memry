/**
 * Dependency-free base64 (variant ORIGINAL, with padding) for platform-free
 * code and tests — the package's `types: []` tsconfig keeps node's Buffer out
 * on purpose, and RN Hermes has no atob/btoa.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? ALPHABET[c & 63] : '='
  }
  return out
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outIndex = 0
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) throw new Error('invalid base64 input')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIndex++] = (buffer >> bits) & 0xff
    }
  }
  return out
}
