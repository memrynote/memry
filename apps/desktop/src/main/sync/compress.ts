import pako from 'pako'

const FLAG_RAW = 0x00
const FLAG_DEFLATE = 0x01

export function compressPayload(data: Uint8Array): Uint8Array {
  if (data.byteLength < 64) {
    return prependFlag(FLAG_RAW, data)
  }

  const compressed = pako.deflate(data)
  if (compressed.byteLength >= data.byteLength) {
    return prependFlag(FLAG_RAW, data)
  }

  return prependFlag(FLAG_DEFLATE, compressed)
}

export function decompressPayload(data: Uint8Array): Uint8Array {
  if (data.byteLength === 0) return data

  const flag = data[0]
  const payload = data.subarray(1)

  if (flag === FLAG_DEFLATE) {
    // pako throws for a corrupt stream, but a TRUNCATED one is different: the
    // inflator never reaches Z_STREAM_END, so `onEnd` never runs, `err` stays 0
    // and `inflate()` returns `undefined` without throwing. Handing that back
    // under a `Uint8Array` return type makes decrypt.ts report
    // `{ content: undefined, verified: true }`, which decrypt-item.ts decodes
    // to '' — a truncated body becomes a SUCCESSFUL decrypt of an empty item
    // and the applier writes it as a content wipe. Throw instead, matching how
    // this function already reports a corrupt stream.
    //
    // Backward compatible: a deflate stream that ends normally always leaves a
    // defined result (pako's onEnd assigns `flattenChunks(chunks)`, which is an
    // empty Uint8Array when there is no output, never undefined). So every
    // payload that decompresses today still decompresses; only the streams that
    // already produced no usable bytes now surface as a failure.
    const inflated = pako.inflate(payload) as Uint8Array | undefined
    if (inflated === undefined) {
      throw new Error('Failed to decompress payload: incomplete deflate stream')
    }
    return inflated
  }

  return payload
}

function prependFlag(flag: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + payload.byteLength)
  result[0] = flag
  result.set(payload, 1)
  return result
}
