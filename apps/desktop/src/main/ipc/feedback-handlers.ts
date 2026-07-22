import { ipcMain } from 'electron'

import { FeedbackChannels } from '@memry/contracts/ipc-channels'
import { FeedbackSubmitSchema } from '@memry/contracts/feedback-api'

import { postToServer } from '../sync/http-client'
import { getValidAccessToken } from '../sync/token-manager'
import { createLogger } from '../lib/logger'

const logger = createLogger('IPC:Feedback')

let registered = false

export const registerFeedbackHandlers = (): void => {
  if (registered) return

  ipcMain.handle(FeedbackChannels.invoke.SUBMIT, async (_event, payload: unknown) => {
    const parsed = FeedbackSubmitSchema.safeParse(payload)
    if (!parsed.success) {
      return { success: false, error: 'INVALID_FEEDBACK' }
    }

    try {
      // Sent when signed in so the server can attach the real plan to the
      // email. Anonymous feedback still works without it.
      const token = await getValidAccessToken().catch(() => null)
      await postToServer('/feedback', parsed.data, token ?? undefined)
      return { success: true }
    } catch (error) {
      logger.error('Failed to submit feedback', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'FEEDBACK_SUBMIT_FAILED'
      }
    }
  })

  registered = true
}

export const unregisterFeedbackHandlers = (): void => {
  if (!registered) return
  ipcMain.removeHandler(FeedbackChannels.invoke.SUBMIT)
  registered = false
}
