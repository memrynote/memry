import { encode } from 'cborg'

import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'

export { CBOR_FIELD_ORDER }

export const encodeCbor = (
  data: Record<string, unknown>,
  fieldOrder: readonly string[]
): Uint8Array => {
  if (process.env.NODE_ENV !== 'production') {
    const definedKeys = Object.keys(data).filter((k) => data[k] !== undefined)
    const extraKeys = definedKeys.filter((k) => !fieldOrder.includes(k))
    if (extraKeys.length > 0) {
      console.warn(
        `[CBOR] Fields not in ordering will be excluded from encoding: ${extraKeys.join(', ')}. Update CBOR_FIELD_ORDER if these should be signed.`
      )
    }
  }

  const ordered: [string, unknown][] = []

  for (const field of fieldOrder) {
    if (field in data && data[field] !== undefined) {
      ordered.push([field, data[field]])
    }
  }

  return encode(new Map(ordered))
}
