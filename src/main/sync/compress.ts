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
    return pako.inflate(payload)
  }

  return payload
}

function prependFlag(flag: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + payload.byteLength)
  result[0] = flag
  result.set(payload, 1)
  return result
}
