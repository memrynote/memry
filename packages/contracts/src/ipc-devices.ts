import { z } from 'zod'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const DEVICE_CHANNELS = {
  GENERATE_LINKING_QR: 'sync:generate-linking-qr',
  LINK_VIA_QR: 'sync:link-via-qr',
  COMPLETE_LINKING_QR: 'sync:complete-linking-qr',
  LINK_VIA_RECOVERY: 'sync:link-via-recovery',
  APPROVE_LINKING: 'sync:approve-linking',
  GET_LINKING_SAS: 'sync:get-linking-sas',
  GET_DEVICES: 'sync:get-devices',
  REMOVE_DEVICE: 'sync:remove-device',
  RENAME_DEVICE: 'sync:rename-device',
  FINALIZE_VAULT_CHOICE: 'sync:finalize-vault-choice',
  PICK_VAULT_FOLDER: 'sync:pick-vault-folder'
} as const

// ============================================================================
// Types
// ============================================================================

export interface GenerateLinkingQrResult {
  qrData?: string
  sessionId?: string
  expiresAt?: number
}

/**
 * Machine-readable reason a linking call failed.
 *
 * The companion `error` string is localized in the main process before it
 * crosses IPC, so it is display text and nothing else. Matching patterns
 * against it only ever works in English — under the other 29 locales the match
 * silently fails and locale-specific recovery UI never renders (issue #1202).
 * Branch on this code instead.
 *
 * Optional and additive: an absent code means "no specific reason", which is
 * how every pre-existing failure path continues to behave.
 */
export const LINK_FAILURE_SETUP_SESSION_EXPIRED = 'setup-session-expired'

export type LinkFailureCode = typeof LINK_FAILURE_SETUP_SESSION_EXPIRED

export interface LinkViaQrInput {
  qrData: string
  oauthToken?: string
  provider?: string
}

export interface LinkViaQrResult {
  success: boolean
  status?: 'waiting_approval' | 'approved' | 'error'
  verificationCode?: string
  error?: string
  errorCode?: LinkFailureCode
}

export interface LinkViaRecoveryInput {
  recoveryPhrase: string
}

export interface LinkViaRecoveryResult {
  success: boolean
  deviceId?: string
  error?: string
  errorCode?: LinkFailureCode
}

export interface CompleteLinkingQrInput {
  sessionId: string
}

export interface LinkingVaultSummary {
  vaultUuid: string
  itemCount?: number
  createdAt?: number | null
}

export interface CompleteLinkingQrResult {
  success: boolean
  deviceId?: string
  error?: string
  vaults?: LinkingVaultSummary[]
}

export interface FinalizeVaultChoiceInput {
  sessionId: string
  parentFolderPath: string
  selectedVaultUuids: string[]
  primaryVaultUuid: string
}

export interface FinalizeVaultChoiceResult {
  success: boolean
  error?: string
}

export interface PickVaultFolderResult {
  path: string | null
}

export interface GetLinkingSasInput {
  sessionId: string
}

export interface GetLinkingSasResult {
  verificationCode?: string
  error?: string
}

export interface ApproveLinkingInput {
  sessionId: string
}

export interface ApproveLinkingResult {
  success: boolean
  error?: string
}

export interface SyncDevice {
  id: string
  name: string
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  linkedAt: number
  lastSyncAt?: number
  isCurrentDevice: boolean
}

export interface GetDevicesResult {
  devices: SyncDevice[]
  email?: string
  needsRecoveryConfirmation: boolean
}

export interface RemoveDeviceInput {
  deviceId: string
}

export interface RemoveDeviceResult {
  success: boolean
  error?: string
}

export interface RenameDeviceInput {
  deviceId: string
  newName: string
}

export interface RenameDeviceResult {
  success: boolean
  error?: string
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const LinkViaQrSchema = z.object({
  qrData: z.string().min(1),
  oauthToken: z.string().optional(),
  provider: z.string().optional()
})

export const LinkViaRecoverySchema = z.object({
  recoveryPhrase: z.string().min(1)
})

export const CompleteLinkingQrSchema = z.object({
  sessionId: z.string().min(1)
})

export const FinalizeVaultChoiceSchema = z.object({
  sessionId: z.string().min(1),
  parentFolderPath: z.string().min(1),
  selectedVaultUuids: z.array(z.string().min(1)).min(1),
  primaryVaultUuid: z.string().min(1)
})

export const PickVaultFolderSchema = z.object({})

export const GetLinkingSasSchema = z.object({
  sessionId: z.string().min(1)
})

export const ApproveLinkingSchema = z.object({
  sessionId: z.string().min(1)
})

export const RemoveDeviceSchema = z.object({
  deviceId: z.string().min(1)
})

export const RenameDeviceSchema = z.object({
  deviceId: z.string().min(1),
  newName: z.string().min(1).max(100)
})

// ============================================================================
// Type Inference
// ============================================================================

export type LinkViaQrSchemaInput = z.infer<typeof LinkViaQrSchema>
export type CompleteLinkingQrSchemaInput = z.infer<typeof CompleteLinkingQrSchema>
export type LinkViaRecoverySchemaInput = z.infer<typeof LinkViaRecoverySchema>
export type ApproveLinkingSchemaInput = z.infer<typeof ApproveLinkingSchema>
export type RemoveDeviceSchemaInput = z.infer<typeof RemoveDeviceSchema>
export type RenameDeviceSchemaInput = z.infer<typeof RenameDeviceSchema>
