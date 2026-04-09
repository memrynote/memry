/**
 * Inbox IPC Handlers
 *
 * Handles all inbox-related IPC communication from renderer.
 * Includes capture, filing, snooze, and bulk operations.
 *
 * @module ipc/inbox-handlers
 */

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument */
// IPC handlers must be async for Electron compatibility, but use synchronous better-sqlite3 operations
// Electron IPC passes untyped arguments that are validated by Zod schemas in each handler

import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  CaptureTextSchema,
  CaptureLinkSchema,
  CaptureImageSchema,
  FileItemSchema
} from '@memry/contracts/inbox-api'
import type { InboxCaptureResponse, TrackSuggestionFeedbackInput } from '@memry/domain-inbox'
import { fetchUrlMetadata, titleFromUrl, isBotPageTitle, extractDomain } from '../inbox/metadata'
import { createLogger } from '../lib/logger'
import { withErrorHandler } from './validate'
import {
  registerInboxCrudHandlers,
  unregisterInboxCrudHandlers
} from './inbox-crud-handlers'
import {
  registerInboxBatchHandlers,
  unregisterInboxBatchHandlers
} from './inbox-batch-handlers'
import {
  registerInboxQueryHandlers,
  unregisterInboxQueryHandlers
} from './inbox-query-handlers'
import {
  createDesktopInboxBatchHandlers,
  createDesktopInboxCrudHandlers,
  createDesktopInboxDomain,
  createDesktopInboxQueryHandlers,
  resumeInboxJobs,
  teardownInboxJobScheduler
} from '../inbox/domain'

// ============================================================================
// Constants
// ============================================================================

const logger = createLogger('IPC:Inbox')

async function stubCaptureClip(): Promise<InboxCaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCapturePdf(): Promise<InboxCaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all inbox IPC handlers
 */
export function registerInboxHandlers(): void {
  resumeInboxJobs()
  const inboxDomain = createDesktopInboxDomain()

  // Capture handlers — Zod validation at IPC trust boundary, withErrorHandler for safe error returns
  ipcMain.handle(
    InboxChannels.invoke.CAPTURE_TEXT,
    (_, input) => withErrorHandler(() => inboxDomain.captureText(CaptureTextSchema.parse(input)))()
  )
  ipcMain.handle(
    InboxChannels.invoke.CAPTURE_LINK,
    (_, input) => withErrorHandler(() => inboxDomain.captureLink(CaptureLinkSchema.parse(input)))()
  )
  ipcMain.handle(
    InboxChannels.invoke.CAPTURE_IMAGE,
    (_, input) => withErrorHandler(() => inboxDomain.captureImage(CaptureImageSchema.parse(input)))()
  )
  ipcMain.handle(
    InboxChannels.invoke.CAPTURE_VOICE,
    (_, input) => withErrorHandler(() => inboxDomain.captureVoice(input))()
  )
  ipcMain.handle(InboxChannels.invoke.CAPTURE_CLIP, (_event, _input) => stubCaptureClip())
  ipcMain.handle(InboxChannels.invoke.CAPTURE_PDF, (_event, _input) => stubCapturePdf())

  const crudHandlers = createDesktopInboxCrudHandlers()
  registerInboxCrudHandlers(crudHandlers)

  const queryHandlers = createDesktopInboxQueryHandlers()
  registerInboxQueryHandlers(queryHandlers)

  // Filing handlers
  ipcMain.handle(
    InboxChannels.invoke.FILE,
    (_, input) => withErrorHandler(() => inboxDomain.fileItem(FileItemSchema.parse(input)))()
  )
  ipcMain.handle(InboxChannels.invoke.GET_SUGGESTIONS, (_, itemId) =>
    withErrorHandler(() => inboxDomain.getSuggestions(itemId))()
  )
  ipcMain.handle(
    InboxChannels.invoke.TRACK_SUGGESTION,
    (_, itemId, itemType, suggestedTo, actualTo, confidence, suggestedTags, actualTags) =>
      withErrorHandler(() =>
        inboxDomain.trackSuggestion({
          itemId,
          itemType,
          suggestedTo,
          actualTo,
          confidence,
          suggestedTags,
          actualTags
        } satisfies TrackSuggestionFeedbackInput)
      )()
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_NOTE, (_, itemId) =>
    withErrorHandler(() => inboxDomain.convertToNote(itemId))()
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_TASK, (_, itemId) =>
    withErrorHandler(() => inboxDomain.convertToTask(itemId))()
  )
  ipcMain.handle(InboxChannels.invoke.LINK_TO_NOTE, (_, itemId, noteId, tags) =>
    withErrorHandler(() => inboxDomain.linkToNote(itemId, noteId, tags || []))()
  )

  // Snooze handlers
  ipcMain.handle(InboxChannels.invoke.SNOOZE, (_, input) =>
    withErrorHandler(() => inboxDomain.snooze(input))()
  )
  ipcMain.handle(InboxChannels.invoke.UNSNOOZE, (_, itemId) =>
    withErrorHandler(() => inboxDomain.unsnooze(itemId))()
  )
  ipcMain.handle(InboxChannels.invoke.GET_SNOOZED, () =>
    withErrorHandler(() => inboxDomain.getSnoozed())()
  )

  const batchHandlers = createDesktopInboxBatchHandlers(crudHandlers.handleArchive)
  registerInboxBatchHandlers(batchHandlers)

  // Transcription handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_TRANSCRIPTION, (_, itemId) =>
    withErrorHandler(() => inboxDomain.retryTranscription(itemId))()
  )

  // Metadata handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_METADATA, (_, id) =>
    withErrorHandler(() => inboxDomain.retryMetadata(id))()
  )

  ipcMain.handle(InboxChannels.invoke.PREVIEW_LINK, async (_, url: string) => {
    try {
      const metadata = await fetchUrlMetadata(url)
      const domain = extractDomain(url)
      const title =
        metadata.title && !isBotPageTitle(metadata.title) ? metadata.title : titleFromUrl(url)
      return {
        title,
        domain,
        favicon: metadata.logo,
        image: metadata.image,
        description: metadata.description
      }
    } catch {
      const domain = extractDomain(url)
      return { title: titleFromUrl(url), domain }
    }
  })

  logger.info('Inbox handlers registered')
}

/**
 * Unregister all inbox IPC handlers
 */
export function unregisterInboxHandlers(): void {
  teardownInboxJobScheduler()

  // Capture
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_TEXT)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_LINK)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_IMAGE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_VOICE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_CLIP)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_PDF)

  unregisterInboxCrudHandlers()
  unregisterInboxQueryHandlers()
  unregisterInboxBatchHandlers()

  // Filing
  ipcMain.removeHandler(InboxChannels.invoke.FILE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SUGGESTIONS)
  ipcMain.removeHandler(InboxChannels.invoke.TRACK_SUGGESTION)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_NOTE)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_TASK)
  ipcMain.removeHandler(InboxChannels.invoke.LINK_TO_NOTE)

  // Snooze
  ipcMain.removeHandler(InboxChannels.invoke.SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.UNSNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SNOOZED)

  // Transcription
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_TRANSCRIPTION)

  // Metadata
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_METADATA)

  logger.info('Inbox handlers unregistered')
}
