import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CaptureImageSchema,
  CaptureLinkSchema,
  CaptureTextSchema,
  CaptureVoiceSchema,
  FileItemSchema,
  TranscribeAudioSchema
} from '@memry/contracts/inbox-api'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { createLogger } from '../lib/logger'
import { extractDomain, isBotPageTitle, titleFromUrl } from '../inbox/metadata-utils'
import {
  createDesktopInboxBatchHandlers,
  createDesktopInboxCrudHandlers,
  createDesktopInboxDomain,
  createDesktopInboxQueryHandlers,
  resumeInboxJobs,
  teardownInboxJobScheduler,
  transcribeAudioInput
} from '../inbox/domain'
import { registerInboxBatchHandlers, unregisterInboxBatchHandlers } from './inbox-batch-handlers'
import { registerInboxCrudHandlers, unregisterInboxCrudHandlers } from './inbox-crud-handlers'
import { registerInboxQueryHandlers, unregisterInboxQueryHandlers } from './inbox-query-handlers'
import { withErrorHandler } from './validate'
import { trackMainEvent } from '../telemetry/track'

const logger = createLogger('IPC:Inbox')

async function stubCaptureClip(_input: unknown) {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCapturePdf(_input: unknown) {
  return { success: false, item: null, error: 'Not implemented yet' }
}

const handleTrackSuggestion = withErrorHandler(
  async (
    itemId: string,
    itemType: string,
    suggestedTo: string,
    actualTo: string,
    confidence: number,
    suggestedTags: string[] = [],
    actualTags: string[] = []
  ) =>
    createDesktopInboxDomain().trackSuggestion({
      itemId,
      itemType,
      suggestedTo,
      actualTo,
      confidence,
      suggestedTags,
      actualTags
    }),
  'Failed to track suggestion'
)

const handleCaptureClipIpc = async (_event: IpcMainInvokeEvent, input: unknown) =>
  stubCaptureClip(input)

const handleCapturePdfIpc = async (_event: IpcMainInvokeEvent, input: unknown) =>
  stubCapturePdf(input)

const handleTrackSuggestionIpc = (
  _event: IpcMainInvokeEvent,
  itemId: string,
  itemType: string,
  suggestedTo: string,
  actualTo: string,
  confidence: number,
  suggestedTags: string[] = [],
  actualTags: string[] = []
) =>
  handleTrackSuggestion(
    itemId,
    itemType,
    suggestedTo,
    actualTo,
    confidence,
    suggestedTags,
    actualTags
  )

export function registerInboxHandlers(): void {
  resumeInboxJobs()

  const inboxDomain = createDesktopInboxDomain()
  const crudHandlers = createDesktopInboxCrudHandlers()
  const queryHandlers = createDesktopInboxQueryHandlers()
  const batchHandlers = createDesktopInboxBatchHandlers(crudHandlers.handleArchive)

  const trackInboxCaptured = (captureType: string, success: boolean): void => {
    trackMainEvent('inbox_captured', {
      surface: 'inbox',
      action: 'captured',
      objectType: `inbox_${captureType}`,
      result: success ? 'success' : 'failed',
      dimensions: { capture_type: captureType }
    })
  }

  ipcMain.handle(InboxChannels.invoke.CAPTURE_TEXT, async (_, input) => {
    const result = await inboxDomain.captureText(CaptureTextSchema.parse(input))
    trackInboxCaptured('text', Boolean(result?.success))
    return result
  })
  ipcMain.handle(InboxChannels.invoke.CAPTURE_LINK, async (_, input) => {
    const result = await inboxDomain.captureLink(CaptureLinkSchema.parse(input))
    trackInboxCaptured('link', Boolean(result?.success))
    return result
  })
  ipcMain.handle(InboxChannels.invoke.CAPTURE_IMAGE, async (_, input) => {
    const result = await inboxDomain.captureImage(CaptureImageSchema.parse(input))
    trackInboxCaptured('image', Boolean(result?.success))
    return result
  })
  ipcMain.handle(InboxChannels.invoke.CAPTURE_VOICE, async (_, input) => {
    const result = await inboxDomain.captureVoice(CaptureVoiceSchema.parse(input))
    trackInboxCaptured('voice', Boolean(result?.success))
    return result
  })
  ipcMain.handle(InboxChannels.invoke.CAPTURE_CLIP, handleCaptureClipIpc)
  ipcMain.handle(InboxChannels.invoke.CAPTURE_PDF, handleCapturePdfIpc)

  registerInboxCrudHandlers(crudHandlers)
  registerInboxQueryHandlers(queryHandlers)
  registerInboxBatchHandlers(batchHandlers)

  ipcMain.handle(InboxChannels.invoke.FILE, async (_, input) => {
    const result = await inboxDomain.fileItem(FileItemSchema.parse(input))
    trackMainEvent('inbox_filed', {
      surface: 'inbox',
      action: 'filed',
      result: result?.success ? 'success' : 'failed'
    })
    return result
  })
  ipcMain.handle(InboxChannels.invoke.GET_SUGGESTIONS, (_, itemId) =>
    inboxDomain.getSuggestions(itemId)
  )
  ipcMain.handle(InboxChannels.invoke.TRACK_SUGGESTION, handleTrackSuggestionIpc)
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_NOTE, (_, itemId) =>
    inboxDomain.convertToNote(itemId)
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_TASK, (_, itemId, input) =>
    inboxDomain.convertToTask(itemId, input)
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_EVENT, (_, itemId, input) =>
    inboxDomain.convertToEvent(itemId, input)
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_REMINDER, (_, itemId, input) =>
    inboxDomain.convertToReminder(itemId, input)
  )
  ipcMain.handle(InboxChannels.invoke.LINK_TO_NOTE, (_, itemId, noteId, tags) =>
    inboxDomain.linkToNote(itemId, noteId, tags || [])
  )
  ipcMain.handle(InboxChannels.invoke.SNOOZE, async (_, input) => {
    const result = await inboxDomain.snooze(input)
    trackMainEvent('inbox_snoozed', {
      surface: 'inbox',
      action: 'snoozed',
      result: result?.success ? 'success' : 'failed'
    })
    return result
  })
  ipcMain.handle(InboxChannels.invoke.UNSNOOZE, (_, itemId) => inboxDomain.unsnooze(itemId))
  ipcMain.handle(InboxChannels.invoke.GET_SNOOZED, () => inboxDomain.getSnoozed())
  ipcMain.handle(InboxChannels.invoke.RETRY_TRANSCRIPTION, (_, itemId) =>
    inboxDomain.retryTranscription(itemId)
  )
  ipcMain.handle(InboxChannels.invoke.RETRY_METADATA, (_, itemId) =>
    inboxDomain.retryMetadata(itemId)
  )
  ipcMain.handle(InboxChannels.invoke.TRANSCRIBE_AUDIO, (_, input) =>
    transcribeAudioInput(TranscribeAudioSchema.parse(input))
  )

  ipcMain.handle(InboxChannels.invoke.PREVIEW_LINK, async (_, url: string) => {
    try {
      const { fetchUrlMetadata } = await import('../inbox/metadata')
      const metadata = await fetchUrlMetadata(url)
      const domain = extractDomain(url)
      const title =
        metadata.title && !isBotPageTitle(metadata.title) ? metadata.title : titleFromUrl(url)

      return {
        title,
        domain,
        favicon: metadata.logo,
        image: metadata.image,
        description: metadata.description,
        siteName: metadata.publisher
      }
    } catch {
      const domain = extractDomain(url)
      return { title: titleFromUrl(url), domain }
    }
  })
}

export function unregisterInboxHandlers(): void {
  teardownInboxJobScheduler()

  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_TEXT)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_LINK)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_IMAGE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_VOICE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_CLIP)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_PDF)

  unregisterInboxCrudHandlers()
  unregisterInboxQueryHandlers()
  unregisterInboxBatchHandlers()

  ipcMain.removeHandler(InboxChannels.invoke.FILE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SUGGESTIONS)
  ipcMain.removeHandler(InboxChannels.invoke.TRACK_SUGGESTION)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_NOTE)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_TASK)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_EVENT)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_REMINDER)
  ipcMain.removeHandler(InboxChannels.invoke.LINK_TO_NOTE)
  ipcMain.removeHandler(InboxChannels.invoke.SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.UNSNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SNOOZED)
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_TRANSCRIPTION)
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_METADATA)
  ipcMain.removeHandler(InboxChannels.invoke.TRANSCRIBE_AUDIO)

  logger.info('Inbox handlers unregistered')
}
