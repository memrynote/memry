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

/** Yields `bytes` in slices of at most `size` bytes. */
export function* sliceChunks(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('The chunk size is a positive integer')
  }
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}
