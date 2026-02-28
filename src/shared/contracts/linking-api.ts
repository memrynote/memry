import { z } from 'zod'

export const LINKING_SESSION_STATUSES = [
  'pending',
  'scanned',
  'approved',
  'completed',
  'expired'
] as const

export type LinkingSessionStatus = (typeof LINKING_SESSION_STATUSES)[number]

export const InitiateLinkingRequestSchema = z.object({
  ephemeralPublicKey: z.string().min(1)
})

export const ScanLinkingRequestSchema = z.object({
  sessionId: z.string().min(1),
  newDevicePublicKey: z.string().min(1),
  newDeviceConfirm: z.string().min(1),
  linkingSecret: z.string().min(1),
  scanProof: z.string().min(1)
})

export const ApproveLinkingRequestSchema = z.object({
  sessionId: z.string().min(1),
  encryptedMasterKey: z.string().min(1),
  encryptedKeyNonce: z.string().min(1),
  keyConfirm: z.string().min(1)
})

export const CompleteLinkingRequestSchema = z.object({
  sessionId: z.string().min(1)
})

export const InitiateLinkingResponseSchema = z.object({
  sessionId: z.string(),
  expiresAt: z.number(),
  linkingSecret: z.string()
})

export const ScanLinkingResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(LINKING_SESSION_STATUSES).optional()
})

export const ApproveLinkingResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(LINKING_SESSION_STATUSES).optional()
})

export const CompleteLinkingResponseSchema = z.object({
  success: z.boolean(),
  encryptedMasterKey: z.string().optional(),
  encryptedKeyNonce: z.string().optional(),
  keyConfirm: z.string().optional()
})

export type InitiateLinkingRequest = z.infer<typeof InitiateLinkingRequestSchema>
export type ScanLinkingRequest = z.infer<typeof ScanLinkingRequestSchema>
export type ApproveLinkingRequest = z.infer<typeof ApproveLinkingRequestSchema>
export type CompleteLinkingRequest = z.infer<typeof CompleteLinkingRequestSchema>
export type InitiateLinkingResponse = z.infer<typeof InitiateLinkingResponseSchema>
export type ScanLinkingResponse = z.infer<typeof ScanLinkingResponseSchema>
export type ApproveLinkingResponse = z.infer<typeof ApproveLinkingResponseSchema>
export type CompleteLinkingResponse = z.infer<typeof CompleteLinkingResponseSchema>
