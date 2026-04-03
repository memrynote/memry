import {
  useCaptureText,
  useCaptureLink,
  useUpdateInboxItem,
  useArchiveInboxItem,
  useFileInboxItem,
  useConvertToNote,
  useAddInboxTag,
  useRemoveInboxTag,
  useSnoozeInboxItem,
  useUnsnoozeInboxItem,
  useBulkArchiveInboxItems,
  useBulkTagInboxItems,
  useFileAllStale,
  useRetryTranscription,
  useRetryMetadata
} from './use-inbox-mutations'

export function useInboxOperations() {
  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const updateItem = useUpdateInboxItem()
  const archiveItem = useArchiveInboxItem()
  const fileItem = useFileInboxItem()
  const convertToNote = useConvertToNote()
  const addTag = useAddInboxTag()
  const removeTag = useRemoveInboxTag()
  const snoozeItem = useSnoozeInboxItem()
  const unsnoozeItem = useUnsnoozeInboxItem()
  const bulkArchive = useBulkArchiveInboxItems()
  const bulkTag = useBulkTagInboxItems()
  const fileAllStale = useFileAllStale()
  const retryTranscription = useRetryTranscription()
  const retryMetadata = useRetryMetadata()

  return {
    captureText: captureText.mutateAsync,
    captureLink: captureLink.mutateAsync,
    isCaptureTextPending: captureText.isPending,
    isCaptureLinkPending: captureLink.isPending,

    updateItem: updateItem.mutateAsync,
    archiveItem: archiveItem.mutateAsync,
    isUpdatePending: updateItem.isPending,
    isArchivePending: archiveItem.isPending,

    fileItem: fileItem.mutateAsync,
    convertToNote: convertToNote.mutateAsync,
    isFilePending: fileItem.isPending,
    isConvertPending: convertToNote.isPending,

    addTag: addTag.mutateAsync,
    removeTag: removeTag.mutateAsync,

    snoozeItem: snoozeItem.mutateAsync,
    unsnoozeItem: unsnoozeItem.mutateAsync,

    bulkArchive: bulkArchive.mutateAsync,
    bulkTag: bulkTag.mutateAsync,
    fileAllStale: fileAllStale.mutateAsync,
    isBulkArchivePending: bulkArchive.isPending,
    isBulkTagPending: bulkTag.isPending,
    isFileAllStalePending: fileAllStale.isPending,

    retryTranscription: retryTranscription.mutateAsync,
    isRetryTranscriptionPending: retryTranscription.isPending,

    retryMetadata: retryMetadata.mutateAsync,
    isRetryMetadataPending: retryMetadata.isPending
  }
}
