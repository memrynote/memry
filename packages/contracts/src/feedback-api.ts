import { z } from 'zod'

/**
 * Beta feedback submitted from the desktop app. Anonymous-friendly: only the
 * message is required. When an email is present (signed-in user or typed in),
 * the server sets it as Reply-To so we can reply for further discussion.
 */
export const FeedbackSubmitSchema = z.object({
  message: z.string().trim().min(1).max(5000),
  email: z.string().trim().email().max(320).optional(),
  appVersion: z.string().max(50).optional(),
  platform: z.string().max(50).optional()
})

export type FeedbackSubmit = z.infer<typeof FeedbackSubmitSchema>

export interface FeedbackSubmitResult {
  success: boolean
  error?: string
}
