import { z } from 'zod'
import {
  ENCRYPTABLE_ITEM_TYPES,
  SYNC_OPERATIONS,
  type EncryptableItemType,
  type SyncOperation
} from './sync-api'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const CRYPTO_CHANNELS = {
  ENCRYPT_ITEM: 'crypto:encrypt-item',
  DECRYPT_ITEM: 'crypto:decrypt-item',
  VERIFY_SIGNATURE: 'crypto:verify-signature',
  ROTATE_KEYS: 'crypto:rotate-keys',
  GET_ROTATION_PROGRESS: 'crypto:get-rotation-progress'
} as const

// ============================================================================
// Types
// ============================================================================

export interface EncryptItemInput {
  itemId: string
  type: EncryptableItemType
  content: Record<string, unknown>
  operation?: SyncOperation
  deletedAt?: number
  metadata?: Record<string, unknown>
}

export interface EncryptItemResult {
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
}

export interface DecryptItemInput {
  itemId: string
  type: EncryptableItemType
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  operation?: SyncOperation
  deletedAt?: number
  metadata?: Record<string, unknown>
}

export interface DecryptItemResult {
  success: boolean
  content?: Record<string, unknown>
  error?: string
}

export interface VerifySignatureInput {
  itemId: string
  type: EncryptableItemType
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  operation?: SyncOperation
  deletedAt?: number
  metadata?: Record<string, unknown>
}

export interface VerifySignatureResult {
  valid: boolean
}

export interface RotateKeysInput {
  confirm: boolean
}

export interface RotateKeysResult {
  success: boolean
  newRecoveryPhrase?: string
  error?: string
}

export type RotationPhase = 'preparing' | 're-encrypting' | 'finalizing' | 'complete'

export interface GetRotationProgressResult {
  inProgress: boolean
  totalItems?: number
  processedItems?: number
  phase?: RotationPhase
}

// ============================================================================
// Zod Schemas
// ============================================================================

const ItemTypeEnum = z.enum(ENCRYPTABLE_ITEM_TYPES)
const OperationEnum = z.enum(SYNC_OPERATIONS)

export const EncryptItemSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  content: z.record(z.string(), z.unknown()),
  operation: OperationEnum.optional(),
  deletedAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const DecryptItemSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  operation: OperationEnum.optional(),
  deletedAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const VerifySignatureSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  operation: OperationEnum.optional(),
  deletedAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const RotateKeysSchema = z.object({
  confirm: z.boolean()
})

// ============================================================================
// Type Inference
// ============================================================================

export type EncryptItemSchemaInput = z.infer<typeof EncryptItemSchema>
export type DecryptItemSchemaInput = z.infer<typeof DecryptItemSchema>
export type VerifySignatureSchemaInput = z.infer<typeof VerifySignatureSchema>
export type RotateKeysSchemaInput = z.infer<typeof RotateKeysSchema>
