import { encode, decode } from 'cborg'

import { CBOR_FIELD_ORDER, type CborPayloadType } from '@memry/contracts/cbor-ordering'

export const encodeCbor = (
  data: Record<string, unknown>,
  fieldOrder: readonly string[]
): Uint8Array => {
  const definedKeys = Object.keys(data).filter((k) => data[k] !== undefined)
  const extraKeys = definedKeys.filter((k) => !fieldOrder.includes(k))
  if (extraKeys.length > 0) {
    throw new Error(
      `CBOR encoding rejected: fields not in ordering would be excluded: ${extraKeys.join(', ')}. Update CBOR_FIELD_ORDER.`
    )
  }

  const ordered: [string, unknown][] = []

  for (const field of fieldOrder) {
    if (field in data && data[field] !== undefined) {
      ordered.push([field, data[field]])
    }
  }

  return encode(new Map(ordered))
}

export const encodeSignaturePayload = (
  payload: Record<string, unknown>,
  payloadType: CborPayloadType = 'SYNC_ITEM'
): Uint8Array => encodeCbor(payload, CBOR_FIELD_ORDER[payloadType])

export const decodePayload = <T = unknown>(data: Uint8Array): T => decode(data) as T
