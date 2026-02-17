export const CBOR_FIELD_ORDER = {
  SYNC_ITEM: [
    'id',
    'type',
    'operation',
    'cryptoVersion',
    'encryptedKey',
    'keyNonce',
    'encryptedData',
    'dataNonce',
    'deletedAt',
    'metadata'
  ] as const,
  TOMBSTONE: ['id', 'type', 'deletedAt', 'deviceId'] as const,
  LINKING_PROOF: ['sessionId', 'devicePublicKey'] as const,
  KEY_CONFIRM: ['sessionId', 'encryptedMasterKey'] as const
} as const

export type CborPayloadType = keyof typeof CBOR_FIELD_ORDER
export type CborFieldOrder = typeof CBOR_FIELD_ORDER
