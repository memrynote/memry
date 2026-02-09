import { encode } from 'cborg'

import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'

export { CBOR_FIELD_ORDER }

export const encodeCbor = (
  data: Record<string, unknown>,
  fieldOrder: readonly string[]
): Uint8Array => {
  const ordered: [string, unknown][] = []

  for (const field of fieldOrder) {
    if (field in data && data[field] !== undefined) {
      ordered.push([field, data[field]])
    }
  }

  return encode(new Map(ordered))
}
