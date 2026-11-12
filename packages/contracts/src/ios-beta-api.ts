import { z } from 'zod'

/** Where in the desktop app the user asked for the iPhone TestFlight invite. */
export const IOS_BETA_SOURCES = ['launch_prompt', 'settings', 'help_menu'] as const
export type IosBetaSource = (typeof IOS_BETA_SOURCES)[number]

/** Renderer → main: what the user typed and where. */
export const IosBetaJoinInputSchema = z.object({
  // oxlint-disable-next-line typescript/no-deprecated -- z.email() would validate before trim(); this must trim first so padded input still passes
  email: z.string().trim().email().max(254),
  source: z.enum(IOS_BETA_SOURCES)
})

export type IosBetaJoinInput = z.infer<typeof IosBetaJoinInputSchema>

/**
 * Main → sync server (`POST /ios-beta/join`). `installId` is the raw telemetry install id,
 * sent only while telemetry is on. The server hashes it and never stores or forwards it raw.
 */
export const IosBetaJoinRequestSchema = IosBetaJoinInputSchema.extend({
  installId: z.uuid().optional(),
  appVersion: z.string().max(50),
  platform: z.string().max(50)
})

export type IosBetaJoinRequest = z.infer<typeof IosBetaJoinRequestSchema>

export interface IosBetaJoinResult {
  success: boolean
  error?: string
}
