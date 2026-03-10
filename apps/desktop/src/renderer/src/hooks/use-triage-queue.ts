import { useState, useCallback, useMemo } from 'react'
import type { InboxItemListItem } from '@/types'
import type { TriageAction } from '@memry/contracts/inbox-api'
import {
  useArchiveInboxItem,
  useConvertToNote,
  useConvertToTask,
  useFileInboxItem,
  useSnoozeInboxItem,
  useInboxList
} from './use-inbox'
import type { FileItemInput, SnoozeInput } from '@/services/inbox-service'

export interface TriageQueueState {
  currentIndex: number
  totalItems: number
  currentItem: InboxItemListItem | null
  completedCount: number
  isComplete: boolean
  isLoading: boolean
  items: InboxItemListItem[]
}

export interface TriageQueueActions {
  discard: () => Promise<void>
  convertToTask: () => Promise<void>
  expandToNote: () => Promise<void>
  file: (input: FileItemInput) => Promise<void>
  defer: (input: SnoozeInput) => Promise<void>
  skip: () => void
  reset: () => void
  advanceAfterExternalAction: () => void
}

export interface UseTriageQueueResult {
  state: TriageQueueState
  actions: TriageQueueActions
  lastAction: TriageAction | null
}

export function useTriageQueue(): UseTriageQueueResult {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set())
  const [lastAction, setLastAction] = useState<TriageAction | null>(null)

  const {
    items: allItems,
    total,
    isLoading
  } = useInboxList({
    includeSnoozed: false,
    sortBy: 'created',
    sortOrder: 'asc',
    limit: 200
  })

  const archiveMutation = useArchiveInboxItem()
  const convertToNoteMutation = useConvertToNote()
  const convertToTaskMutation = useConvertToTask()
  const fileMutation = useFileInboxItem()
  const snoozeMutation = useSnoozeInboxItem()

  const items = useMemo(() => {
    return allItems.filter((item) => !processedIds.has(item.id))
  }, [allItems, processedIds])

  const currentItem = items[currentIndex] ?? null
  const isComplete = items.length === 0 || (currentIndex >= items.length && items.length > 0)

  const advance = useCallback(
    (action: TriageAction) => {
      if (!currentItem) return
      setLastAction(action)
      setCompletedCount((c) => c + 1)
      setProcessedIds((prev) => new Set([...prev, currentItem.id]))
    },
    [currentItem]
  )

  const discard = useCallback(async () => {
    if (!currentItem) return
    const result = await archiveMutation.mutateAsync(currentItem.id)
    if (!result.success) {
      throw new Error(result.error || 'Failed to discard')
    }
    advance('discard')
  }, [currentItem, archiveMutation, advance])

  const convertToTask = useCallback(async () => {
    if (!currentItem) return
    const result = await convertToTaskMutation.mutateAsync(currentItem.id)
    if (!result.success) {
      throw new Error(result.error || 'Failed to convert to task')
    }
    advance('convert-to-task')
  }, [currentItem, convertToTaskMutation, advance])

  const expandToNote = useCallback(async () => {
    if (!currentItem) return
    const result = await convertToNoteMutation.mutateAsync(currentItem.id)
    if (!result.success) {
      throw new Error(result.error || 'Failed to expand to note')
    }
    advance('expand-to-note')
  }, [currentItem, convertToNoteMutation, advance])

  const file = useCallback(
    async (input: FileItemInput) => {
      if (!currentItem) return
      const result = await fileMutation.mutateAsync(input)
      if (!result.success) {
        throw new Error(result.error || 'Failed to file')
      }
      advance('file')
    },
    [currentItem, fileMutation, advance]
  )

  const defer = useCallback(
    async (input: SnoozeInput) => {
      if (!currentItem) return
      const result = await snoozeMutation.mutateAsync(input)
      if (!result.success) {
        throw new Error(result.error || 'Failed to snooze')
      }
      advance('defer')
    },
    [currentItem, snoozeMutation, advance]
  )

  const skip = useCallback(() => {
    setCurrentIndex((i) => Math.min(i + 1, items.length))
  }, [items.length])

  const advanceAfterExternalAction = useCallback(() => {
    advance('discard')
  }, [advance])

  const reset = useCallback(() => {
    setCurrentIndex(0)
    setCompletedCount(0)
    setProcessedIds(new Set())
    setLastAction(null)
  }, [])

  return {
    state: {
      currentIndex,
      totalItems: total,
      currentItem,
      completedCount,
      isComplete,
      isLoading,
      items
    },
    actions: {
      discard,
      convertToTask,
      expandToNote,
      file,
      defer,
      skip,
      reset,
      advanceAfterExternalAction
    },
    lastAction
  }
}
