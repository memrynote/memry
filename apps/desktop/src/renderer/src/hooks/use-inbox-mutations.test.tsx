import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const reactQuery = vi.hoisted(() => ({
  queryClient: {
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn()
  },
  mutationConfigs: [] as Array<{
    mutationFn: (input: never) => unknown
    onSuccess?: (data: unknown, variables: never) => void
  }>
}))

const inboxService = vi.hoisted(() => ({
  captureText: vi.fn(),
  captureLink: vi.fn(),
  captureVoice: vi.fn(),
  captureImage: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  deletePermanent: vi.fn(),
  file: vi.fn(),
  convertToNote: vi.fn(),
  convertToTask: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  bulkArchive: vi.fn(),
  bulkTag: vi.fn(),
  fileAllStale: vi.fn(),
  retryTranscription: vi.fn(),
  retryMetadata: vi.fn()
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => reactQuery.queryClient,
  useMutation: (config: (typeof reactQuery.mutationConfigs)[number]) => {
    reactQuery.mutationConfigs.push(config)
    return {
      mutate: vi.fn((variables) => config.onSuccess?.({}, variables)),
      isPending: false
    }
  }
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService
}))

import {
  useAddInboxTag,
  useArchiveInboxItem,
  useBulkArchiveInboxItems,
  useBulkTagInboxItems,
  useCaptureImage,
  useCaptureLink,
  useCaptureText,
  useCaptureVoice,
  useConvertToNote,
  useConvertToTask,
  useDeletePermanentInboxItem,
  useFileAllStale,
  useFileInboxItem,
  useRemoveInboxTag,
  useRetryMetadata,
  useRetryTranscription,
  useSnoozeInboxItem,
  useUnarchiveInboxItem,
  useUnsnoozeInboxItem,
  useUpdateInboxItem
} from './use-inbox-mutations'

describe('use-inbox-mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reactQuery.mutationConfigs.length = 0
  })

  function latestMutation() {
    return reactQuery.mutationConfigs.at(-1)!
  }

  it('invalidates list and stats caches for capture mutations', () => {
    const hooks = [
      [useCaptureText, inboxService.captureText, { title: 'Note' }],
      [useCaptureLink, inboxService.captureLink, { url: 'https://example.com' }],
      [useCaptureVoice, inboxService.captureVoice, { audio: new Uint8Array([1]) }],
      [useCaptureImage, inboxService.captureImage, { dataUrl: 'data:image/png;base64,a' }]
    ] as const

    for (const [hook, service, input] of hooks) {
      renderHook(() => hook())
      latestMutation().mutationFn(input as never)
      latestMutation().onSuccess?.({}, input as never)

      expect(service).toHaveBeenCalledWith(input)
    }

    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'list']
    })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'stats']
    })
  })

  it('handles item CRUD cache updates', () => {
    renderHook(() => useUpdateInboxItem())
    latestMutation().mutationFn({ id: 'item-1', title: 'Updated' } as never)
    latestMutation().onSuccess?.({}, { id: 'item-1' } as never)
    expect(inboxService.update).toHaveBeenCalledWith({ id: 'item-1', title: 'Updated' })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-1']
    })

    renderHook(() => useArchiveInboxItem())
    latestMutation().mutationFn('item-2' as never)
    latestMutation().onSuccess?.({}, 'item-2' as never)
    expect(inboxService.archive).toHaveBeenCalledWith('item-2')
    expect(reactQuery.queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-2']
    })

    renderHook(() => useUnarchiveInboxItem())
    latestMutation().mutationFn('item-3' as never)
    latestMutation().onSuccess?.({}, 'item-3' as never)
    expect(inboxService.unarchive).toHaveBeenCalledWith('item-3')
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'archived', {}]
    })

    renderHook(() => useDeletePermanentInboxItem())
    latestMutation().mutationFn('item-4' as never)
    latestMutation().onSuccess?.({}, 'item-4' as never)
    expect(inboxService.deletePermanent).toHaveBeenCalledWith('item-4')
    expect(reactQuery.queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-4']
    })
  })

  it('handles filing and conversion cache updates', () => {
    renderHook(() => useFileInboxItem())
    latestMutation().mutationFn({ itemId: 'item-1', destination: { type: 'folder' } } as never)
    latestMutation().onSuccess?.({}, { itemId: 'item-1' } as never)
    expect(inboxService.file).toHaveBeenCalledWith({
      itemId: 'item-1',
      destination: { type: 'folder' }
    })
    expect(reactQuery.queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-1']
    })

    renderHook(() => useConvertToNote())
    latestMutation().mutationFn('note-item' as never)
    latestMutation().onSuccess?.({}, 'note-item' as never)
    expect(inboxService.convertToNote).toHaveBeenCalledWith('note-item')

    renderHook(() => useConvertToTask())
    latestMutation().mutationFn('task-item' as never)
    latestMutation().onSuccess?.({}, 'task-item' as never)
    expect(inboxService.convertToTask).toHaveBeenCalledWith('task-item')
  })

  it('handles tag, snooze, bulk, and retry invalidations', () => {
    renderHook(() => useAddInboxTag())
    latestMutation().mutationFn({ itemId: 'item-1', tag: 'later' } as never)
    latestMutation().onSuccess?.({}, { itemId: 'item-1', tag: 'later' } as never)
    expect(inboxService.addTag).toHaveBeenCalledWith('item-1', 'later')

    renderHook(() => useRemoveInboxTag())
    latestMutation().mutationFn({ itemId: 'item-1', tag: 'later' } as never)
    latestMutation().onSuccess?.({}, { itemId: 'item-1', tag: 'later' } as never)
    expect(inboxService.removeTag).toHaveBeenCalledWith('item-1', 'later')

    renderHook(() => useSnoozeInboxItem())
    latestMutation().mutationFn({ itemId: 'item-2', snoozeUntil: '2026-05-11' } as never)
    latestMutation().onSuccess?.({}, { itemId: 'item-2' } as never)
    expect(inboxService.snooze).toHaveBeenCalledWith({
      itemId: 'item-2',
      snoozeUntil: '2026-05-11'
    })

    renderHook(() => useUnsnoozeInboxItem())
    latestMutation().mutationFn('item-3' as never)
    latestMutation().onSuccess?.({}, 'item-3' as never)
    expect(inboxService.unsnooze).toHaveBeenCalledWith('item-3')

    renderHook(() => useBulkArchiveInboxItems())
    latestMutation().mutationFn({ itemIds: ['a', 'b'] } as never)
    latestMutation().onSuccess?.({}, { itemIds: ['a', 'b'] } as never)
    expect(inboxService.bulkArchive).toHaveBeenCalledWith({ itemIds: ['a', 'b'] })
    expect(reactQuery.queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'a']
    })

    renderHook(() => useBulkTagInboxItems())
    latestMutation().mutationFn({ itemIds: ['a'], tags: ['later'] } as never)
    latestMutation().onSuccess?.({}, { itemIds: ['a'], tags: ['later'] } as never)
    expect(inboxService.bulkTag).toHaveBeenCalledWith({ itemIds: ['a'], tags: ['later'] })

    renderHook(() => useFileAllStale())
    latestMutation().mutationFn(undefined as never)
    latestMutation().onSuccess?.({}, undefined as never)
    expect(inboxService.fileAllStale).toHaveBeenCalled()

    renderHook(() => useRetryTranscription())
    latestMutation().mutationFn('voice-1' as never)
    latestMutation().onSuccess?.({}, 'voice-1' as never)
    expect(inboxService.retryTranscription).toHaveBeenCalledWith('voice-1')

    renderHook(() => useRetryMetadata())
    latestMutation().mutationFn('link-1' as never)
    latestMutation().onSuccess?.({}, 'link-1' as never)
    expect(inboxService.retryMetadata).toHaveBeenCalledWith('link-1')
  })
})
