import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import type {
  InboxBulkResponse,
  InboxCaptureResponse,
  InboxFileResponse
} from '@memry/rpc/inbox'
import {
  inboxService,
  type CaptureTextInput,
  type CaptureLinkInput,
  type CaptureImageInput,
  type CaptureVoiceInput,
  type InboxUpdateInput,
  type FileItemInput,
  type SnoozeInput,
  type BulkArchiveInput,
  type BulkTagInput
} from '@/services/inbox-service'
import { inboxKeys } from './inbox-query-keys'

// =============================================================================
// Capture Mutations
// =============================================================================

export function useCaptureText(): UseMutationResult<InboxCaptureResponse, Error, CaptureTextInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureTextInput) => inboxService.captureText(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useCaptureLink(): UseMutationResult<InboxCaptureResponse, Error, CaptureLinkInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureLinkInput) => inboxService.captureLink(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useCaptureVoice(): UseMutationResult<
  InboxCaptureResponse,
  Error,
  CaptureVoiceInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureVoiceInput) => inboxService.captureVoice(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useCaptureImage(): UseMutationResult<
  InboxCaptureResponse,
  Error,
  CaptureImageInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureImageInput) => inboxService.captureImage(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// CRUD Mutations
// =============================================================================

export function useUpdateInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: InboxUpdateInput) => inboxService.update(input),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(variables.id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    }
  })
}

export function useArchiveInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.archive(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useUnarchiveInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.unarchive(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useDeletePermanentInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.deletePermanent(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Filing Mutations
// =============================================================================

export function useFileInboxItem(): UseMutationResult<InboxFileResponse, Error, FileItemInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: FileItemInput) => inboxService.file(input),
    onSuccess: (_, variables) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(variables.itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useConvertToNote(): UseMutationResult<InboxFileResponse, Error, string> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.convertToNote(itemId),
    onSuccess: (_, itemId) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useConvertToTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.convertToTask(itemId),
    onSuccess: (_, itemId) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Tag Mutations
// =============================================================================

export function useAddInboxTag() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ itemId, tag }: { itemId: string; tag: string }) =>
      inboxService.addTag(itemId, tag),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

export function useRemoveInboxTag() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ itemId, tag }: { itemId: string; tag: string }) =>
      inboxService.removeTag(itemId, tag),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

// =============================================================================
// Snooze Mutations
// =============================================================================

export function useSnoozeInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SnoozeInput) => inboxService.snooze(input),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    }
  })
}

export function useUnsnoozeInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.unsnooze(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    }
  })
}

// =============================================================================
// Bulk Mutations
// =============================================================================

export function useBulkArchiveInboxItems(): UseMutationResult<
  InboxBulkResponse,
  Error,
  BulkArchiveInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: BulkArchiveInput) => inboxService.bulkArchive(input),
    onSuccess: (_, { itemIds }) => {
      itemIds.forEach((id) => {
        queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useBulkTagInboxItems(): UseMutationResult<InboxBulkResponse, Error, BulkTagInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: BulkTagInput) => inboxService.bulkTag(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

export function useFileAllStale(): UseMutationResult<InboxBulkResponse, Error, void> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => inboxService.fileAllStale(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Transcription & Metadata Mutations
// =============================================================================

export function useRetryTranscription() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.retryTranscription(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
    }
  })
}

export function useRetryMetadata() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.retryMetadata(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    }
  })
}
