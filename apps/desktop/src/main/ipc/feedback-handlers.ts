import { ipcMain } from 'electron'

import { FeedbackChannels } from '@memry/contracts/ipc-channels'
import { FeedbackSubmitSchema } from '@memry/contracts/feedback-api'

import { postToServer } from '../sync/http-client'
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
      await postToServer('/feedback', parsed.data)
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
