import { z } from 'zod'

/**
 * The most diagnostic-log text one submission carries: about half the sync
 * server's 1 MiB API body limit (`MAX_BODY_BYTES_API`), so JSON escaping
 * cannot push a full log over it. iOS trims its log tail to this length.
 */
export const FEEDBACK_LOGS_MAX_CHARS = 512 * 1024

/**
 * Feedback submitted from the desktop and iOS apps. Anonymous-friendly: only
 * the message is required. When an email is present (signed-in user or typed
 * in), the server sets it as Reply-To so we can reply for further discussion.
 *
 * Every field after `platform` is optional and was added for iOS diagnostics.
 * Desktop builds that predate them still validate, and a server that predates
 * them strips them (zod drops unknown keys) and still sends the message.
 */
export const FeedbackSubmitSchema = z.object({
  message: z.string().trim().min(1).max(5000),
  // oxlint-disable-next-line typescript/no-deprecated -- z.email() would validate before trim(); this must trim first so padded input still passes
  email: z.string().trim().email().max(320).optional(),
  appVersion: z.string().max(50).optional(),
  platform: z.string().max(50).optional(),
  appBuild: z.string().max(50).optional(),
  osVersion: z.string().max(50).optional(),
  deviceModel: z.string().max(100).optional(),
  /** The app's own diagnostic log, sent only when the user opts in. Plain text. */
  logs: z.string().min(1).max(FEEDBACK_LOGS_MAX_CHARS).optional()
})

export type FeedbackSubmit = z.infer<typeof FeedbackSubmitSchema>

export interface FeedbackSubmitResult {
  success: boolean
  error?: string
}
