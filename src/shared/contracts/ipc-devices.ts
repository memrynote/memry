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
  RENAME_DEVICE: 'sync:rename-device'
} as const

// ============================================================================
// Types
// ============================================================================

export interface GenerateLinkingQrResult {
  qrData?: string
  sessionId?: string
  expiresAt?: number
}

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
}

export interface LinkViaRecoveryInput {
  recoveryPhrase: string
}

export interface LinkViaRecoveryResult {
  success: boolean
  deviceId?: string
  error?: string
}

export interface CompleteLinkingQrInput {
  sessionId: string
}

export interface CompleteLinkingQrResult {
  success: boolean
  deviceId?: string
  error?: string
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
