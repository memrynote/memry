// JavaScriptCore on iOS has no TextEncoder / TextDecoder / atob / btoa, and
// modules in the bundle use them while they load (whatwg-url-minimum creates
// an encoder, entities decodes its tables with atob). UTF-8 only, which is all
// the URL parser asks for. Imported first, before `ios-globals.ts`.

class Utf8Encoder {
  readonly encoding = 'utf-8'

  encode(input = ''): Uint8Array {
    const bytes: number[] = []
    for (const char of input) {
      const code = char.codePointAt(0) ?? 0
      if (code < 0x80) bytes.push(code)
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
      else if (code < 0x10000)
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
      else
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        )
    }
    return new Uint8Array(bytes)
  }
}

class Utf8Decoder {
  readonly encoding = 'utf-8'

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return ''
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input)
    let out = ''
    let i = 0
    while (i < bytes.length) {
      const lead = bytes[i] ?? 0
      const extra = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0
      let code = extra === 0 ? lead : lead & (0x3f >> extra)
      for (let k = 1; k <= extra; k += 1) code = (code << 6) | ((bytes[i + k] ?? 0) & 0x3f)
      out += String.fromCodePoint(code)
      i += extra + 1
    }
    return out
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 to a binary string, one char per byte. */
function atob(input: string): string {
  const clean = String(input).replace(/[^A-Za-z0-9+/]/g, '')
  let out = ''
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 6) | BASE64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((value >> bits) & 0xff)
    }
  }
  return out
}

/** A binary string, one char per byte, to base64. */
function btoa(input: string): string {
  const text = String(input)
  let out = ''
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i)
    const b = text.charCodeAt(i + 1)
    const c = text.charCodeAt(i + 2)
    out += BASE64[a >> 2]
    out += BASE64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]
    out += Number.isNaN(b) ? '=' : BASE64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]
    out += Number.isNaN(c) ? '=' : BASE64[c & 63]
  }
  return out
}

const scope = globalThis as Record<string, unknown>
if (typeof scope.atob === 'undefined') scope.atob = atob
if (typeof scope.btoa === 'undefined') scope.btoa = btoa
if (typeof scope.TextEncoder === 'undefined') scope.TextEncoder = Utf8Encoder
if (typeof scope.TextDecoder === 'undefined') scope.TextDecoder = Utf8Decoder
