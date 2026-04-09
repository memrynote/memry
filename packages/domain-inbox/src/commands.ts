import type {
  CaptureLinkInput,
  CaptureTextInput,
  CaptureVoiceInput,
  CaptureImageInput,
  FileItemInput,
  InboxCaptureResponse,
  InboxDuplicateMatch,
  InboxFileResponse,
  InboxFilingSuggestion,
  InboxItem,
  InboxMetadata,
  SnoozeInput,
  SnoozedItem,
  TrackSuggestionFeedbackInput
} from './types.ts'

export interface CreateLinkCaptureItemInput {
  url: string
  tags?: string[]
  source?: CaptureTextInput['source']
  itemType: 'link' | 'social'
  metadata: InboxMetadata | null
}

export interface InboxCommandServices {
  findDuplicateByContent(content: string): InboxDuplicateMatch | null
  findDuplicateByUrl(url: string): InboxDuplicateMatch | null
  captureTextItem(input: CaptureTextInput): Promise<InboxCaptureResponse>
  captureLinkItem(input: CreateLinkCaptureItemInput): Promise<InboxCaptureResponse>
  captureImageItem(input: CaptureImageInput): Promise<InboxCaptureResponse>
  captureVoiceItem(input: CaptureVoiceInput): Promise<InboxCaptureResponse>
  isSocialPost(url: string): boolean
  detectSocialPlatform(url: string): 'twitter' | 'other' | null
  storeSocialMetadata(itemId: string, url: string): void
  queueMetadataJob(itemId: string, url: string): void
  getSuggestions(itemId: string): Promise<InboxFilingSuggestion[]>
  trackSuggestionFeedback(input: TrackSuggestionFeedbackInput): void
  fileToFolder(itemId: string, folderPath: string, tags?: string[]): Promise<InboxFileResponse>
  convertToNote(itemId: string): Promise<InboxFileResponse>
  convertToTask(
    itemId: string
  ): Promise<{ success: boolean; taskId: string | null; error?: string }>
  linkToNote(
    itemId: string,
    noteId: string,
    tags?: string[]
  ): Promise<{ success: boolean; error?: string }>
  linkToNotes(
    itemId: string,
    noteIds: string[],
    tags?: string[],
    path?: string
  ): Promise<{ success: boolean; error?: string }>
  snoozeItem(input: SnoozeInput): { success: boolean; error?: string }
  unsnoozeItem(itemId: string): { success: boolean; error?: string }
  getSnoozedItems(): Promise<SnoozedItem[]>
  getItem(itemId: string): InboxItem | null
  markTranscriptionPending(itemId: string): { success: boolean; error?: string }
  markMetadataPending(itemId: string): { success: boolean; error?: string }
  queueTranscriptionJob(itemId: string, attachmentPath: string): void
  reportError?(scope: string, error: unknown): void
}

export interface InboxCommands {
  captureText(input: CaptureTextInput): Promise<InboxCaptureResponse>
  captureLink(input: CaptureLinkInput): Promise<InboxCaptureResponse>
  captureImage(input: CaptureImageInput): Promise<InboxCaptureResponse>
  captureVoice(input: CaptureVoiceInput): Promise<InboxCaptureResponse>
  fileItem(input: FileItemInput): Promise<InboxFileResponse>
  getSuggestions(itemId: string): Promise<{ suggestions: InboxFilingSuggestion[] }>
  trackSuggestion(input: TrackSuggestionFeedbackInput): Promise<{ success: boolean; error?: string }>
  convertToNote(itemId: string): Promise<InboxFileResponse>
  convertToTask(
    itemId: string
  ): Promise<{ success: boolean; taskId: string | null; error?: string }>
  linkToNote(
    itemId: string,
    noteId: string,
    tags?: string[]
  ): Promise<{ success: boolean; error?: string }>
  snooze(input: SnoozeInput): Promise<{ success: boolean; error?: string }>
  unsnooze(itemId: string): Promise<{ success: boolean; error?: string }>
  getSnoozed(): Promise<SnoozedItem[]>
  retryTranscription(itemId: string): Promise<{ success: boolean; error?: string }>
  retryMetadata(itemId: string): Promise<{ success: boolean; error?: string }>
}

function reportError(
  services: Pick<InboxCommandServices, 'reportError'>,
  scope: string,
  error: unknown
): void {
  services.reportError?.(scope, error)
}

function createSocialMetadata(
  url: string,
  platform: ReturnType<InboxCommandServices['detectSocialPlatform']>
): InboxMetadata {
  return {
    platform: platform ?? 'other',
    postUrl: url,
    authorName: '',
    authorHandle: '',
    postContent: '',
    mediaUrls: [],
    extractionStatus: 'pending'
  }
}

function createLinkMetadata(url: string): InboxMetadata {
  return {
    url,
    fetchStatus: 'pending'
  }
}

export function createInboxCommands(services: InboxCommandServices): InboxCommands {
  return {
    async captureText(input) {
      if (!input.force) {
        const duplicate = services.findDuplicateByContent(input.content)
        if (duplicate) {
          return {
            success: true,
            item: null,
            duplicate: true,
            existingItem: duplicate
          }
        }
      }

      return services.captureTextItem(input)
    },

    async captureLink(input) {
      if (!input.force) {
        const duplicate = services.findDuplicateByUrl(input.url)
        if (duplicate) {
          return {
            success: true,
            item: null,
            duplicate: true,
            existingItem: duplicate
          }
        }
      }

      const platform = services.detectSocialPlatform(input.url)
      const isSocial = platform !== null && services.isSocialPost(input.url)
      const result = await services.captureLinkItem({
        url: input.url,
        tags: input.tags,
        source: input.source,
        itemType: isSocial ? 'social' : 'link',
        metadata: isSocial ? createSocialMetadata(input.url, platform) : createLinkMetadata(input.url)
      })

      if (!result.success || !result.item) {
        return result
      }

      if (isSocial) {
        try {
          services.storeSocialMetadata(result.item.id, input.url)
        } catch (error) {
          reportError(services, 'captureLink.storeSocialMetadata', error)
        }
      } else {
        services.queueMetadataJob(result.item.id, input.url)
      }

      return result
    },

    captureImage: (input) => services.captureImageItem(input),
    captureVoice: (input) => services.captureVoiceItem(input),

    async fileItem(input) {
      const { itemId, destination, tags } = input

      switch (destination.type) {
        case 'folder':
          return services.fileToFolder(itemId, destination.path || '', tags)
        case 'new-note':
          return services.convertToNote(itemId)
        case 'note': {
          const noteIds = destination.noteIds?.length
            ? destination.noteIds
            : destination.noteId
              ? [destination.noteId]
              : []

          if (noteIds.length === 0) {
            return {
              success: false,
              filedTo: null,
              error: 'At least one note ID required for linking'
            }
          }

          const result = await services.linkToNotes(itemId, noteIds, tags, destination.path)
          return {
            success: result.success,
            filedTo: noteIds[0],
            noteId: noteIds[0],
            error: result.error
          }
        }
        default:
          return {
            success: false,
            filedTo: null,
            error: 'Invalid destination type'
          }
      }
    },

    async getSuggestions(itemId) {
      try {
        const suggestions = await services.getSuggestions(itemId)
        return { suggestions }
      } catch (error) {
        reportError(services, 'getSuggestions', error)
        return { suggestions: [] }
      }
    },

    async trackSuggestion(input) {
      try {
        services.trackSuggestionFeedback(input)
        return { success: true }
      } catch (error) {
        reportError(services, 'trackSuggestion', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to track feedback'
        }
      }
    },

    convertToNote: (itemId) => services.convertToNote(itemId),
    convertToTask: (itemId) => services.convertToTask(itemId),
    linkToNote: (itemId, noteId, tags) => services.linkToNote(itemId, noteId, tags),

    async snooze(input) {
      if (!input.itemId || !input.snoozeUntil) {
        return { success: false, error: 'itemId and snoozeUntil are required' }
      }

      return services.snoozeItem(input)
    },

    async unsnooze(itemId) {
      if (!itemId) {
        return { success: false, error: 'itemId is required' }
      }

      return services.unsnoozeItem(itemId)
    },

    async getSnoozed() {
      try {
        return await services.getSnoozedItems()
      } catch (error) {
        reportError(services, 'getSnoozed', error)
        return []
      }
    },

    async retryTranscription(itemId) {
      const item = services.getItem(itemId)
      if (!item) {
        return { success: false, error: 'Item not found' }
      }

      if (item.type !== 'voice') {
        return { success: false, error: 'Item is not a voice memo' }
      }

      if (!item.attachmentPath) {
        return { success: false, error: 'No audio file attached to this item' }
      }

      const pending = services.markTranscriptionPending(itemId)
      if (!pending.success) {
        return pending
      }

      services.queueTranscriptionJob(itemId, item.attachmentPath)
      return { success: true }
    },

    async retryMetadata(itemId) {
      const item = services.getItem(itemId)
      if (!item) {
        return { success: false, error: 'Item not found' }
      }

      if (item.type !== 'link') {
        return { success: false, error: 'Item is not a link' }
      }

      if (!item.sourceUrl) {
        return { success: false, error: 'Item has no source URL' }
      }

      const pending = services.markMetadataPending(itemId)
      if (!pending.success) {
        return pending
      }

      services.queueMetadataJob(itemId, item.sourceUrl)
      return { success: true }
    }
  }
}
