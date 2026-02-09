import { encode, decode } from 'cborg'

const SIGNATURE_PAYLOAD_FIELD_ORDER = [
  'id',
  'type',
  'operation',
  'cryptoVersion',
  'encryptedKey',
  'keyNonce',
  'encryptedData',
  'dataNonce',
  'deletedAt',
  'metadata',
] as const

const orderFields = (obj: Record<string, unknown>, fieldOrder: readonly string[]): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {}
  for (const key of fieldOrder) {
    if (key in obj && obj[key] !== undefined) {
      ordered[key] = obj[key]
    }
  }
  return ordered
}

export const encodeSignaturePayload = (payload: Record<string, unknown>): Uint8Array =>
  encode(orderFields(payload, SIGNATURE_PAYLOAD_FIELD_ORDER))

export const decodePayload = <T = unknown>(data: Uint8Array): T =>
  decode(data) as T
