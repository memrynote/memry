/**
 * Base64, without `btoa`/`atob`.
 *
 * Hermes does not provide them and neither React Native 0.86 nor Expo 57's
 * winter runtime installs a polyfill, so every base64 crossing in the app —
 * secure storage, the editor bridge, the WebView asset, attachment payloads —
 * goes through here. Reaching for `globalThis.atob` is a crash on the first
 * call, not a lint nit.
 *
 * The decoder uses a lookup table rather than `indexOf`: the editor asset is a
 * ~1 MB base64 literal, and a 64-step scan per character turns a one-off
 * inflate into a visible stall on the first note open.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const B64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i
  }
  return table
})()

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked into an array and joined: repeated `out +=` over a multi-megabyte
  // payload is what makes a naive encoder quadratic on some engines.
  const parts: string[] = []
  let chunk = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    chunk += B64_ALPHABET[a >> 2]
    chunk += B64_ALPHABET[((a & 3) << 4) | (b >> 4)]
    chunk += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '='
    chunk += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : '='
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  if (chunk.length > 0) parts.push(chunk)
  return parts.join('')
}

export function base64ToBytes(base64: string): Uint8Array {
  let end = base64.length
  while (end > 0 && base64.charCodeAt(end - 1) === 61 /* '=' */) end--

  const out = new Uint8Array(Math.floor((end * 3) / 4))
  let outIndex = 0
  let buffer = 0
  let bits = 0

  for (let i = 0; i < end; i++) {
    const code = base64.charCodeAt(i)
    const value = code < 128 ? B64_LOOKUP[code] : -1
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
