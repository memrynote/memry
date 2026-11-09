import { invoke } from '@tauri-apps/api/core'

/** Header that carries the JSON metadata of a raw request (`binary.rs` reads it). */
export const META_HEADER = 'x-memry-meta'

// Header values are ASCII, so every character from DEL up travels as `\uXXXX`, which JSON.parse
// on the Rust side reads back.
function encodeMeta(meta: unknown): string {
  return JSON.stringify(meta).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** Sends `body` as a raw request body with `meta` in the `x-memry-meta` header. */
export function invokeBinary<T = unknown>(
  command: string,
  body: Uint8Array,
  meta: unknown
): Promise<T> {
  return invoke<T>(command, body, { headers: { [META_HEADER]: encodeMeta(meta) } })
}

/** Reads a raw `Response` of a command. */
export async function readBinary(
  command: string,
  args?: Record<string, unknown>
): Promise<Uint8Array> {
  return decodeChunk(await invoke<unknown>(command, args))
}

/** Decodes one raw `Channel` message, which arrives as an `ArrayBuffer`. */
export function decodeChunk(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('A raw channel message is an ArrayBuffer')
}

/**
 * Splits a framed `Response` (`binary::framed`): a 4-byte big-endian header length, the JSON
 * header, then the parts back to back, which the header says the lengths of.
 */
export function decodeFramedHeader(bytes: Uint8Array): { header: unknown; body: Uint8Array } {
  if (bytes.byteLength < 4) throw new RangeError('A framed answer is shorter than its length')
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  if (4 + length > bytes.byteLength) {
    throw new RangeError('A framed answer is shorter than its header')
  }
  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))),
    body: bytes.subarray(4 + length)
  }
}

/** Yields `bytes` in slices of at most `size` bytes. */
export function* sliceChunks(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('The chunk size is a positive integer')
  }
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}
