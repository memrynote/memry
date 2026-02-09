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
  LINKING_PROOF: ['sessionId', 'devicePublicKey', 'timestamp'] as const,
  KEY_CONFIRM: ['sessionId', 'encryptedMasterKey', 'timestamp'] as const
} as const

export type CborFieldOrder = typeof CBOR_FIELD_ORDER
