import { useState, useEffect, useCallback, useRef } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { JournalEntry } from '../../../preload/index.d'
import {
  journalService,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  onJournalEntryCreated
} from '@/services/journal-service'
import { getTemplate, type Template } from '@/services/templates-service'
import { addDays, formatDateToISO, parseISODate } from '@/lib/journal-utils'
import {
  journalKeys,
  ENTRY_STALE_TIME,
  ENTRY_GC_TIME,
  AUTO_SAVE_DELAY_MS,
  PREFETCH_DAYS
} from './journal-query-keys'
import { getI18n } from 'react-i18next'

const log = createLogger('Hook:JournalEntry')

type AppliedJournalTemplate = {
  content: string
  tags: string[]
  properties: Record<string, unknown>
}

function formatDateToken(date: Date, pattern: string | undefined, locale: string): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  if (pattern) {
    return pattern.replace(/YYYY/g, year).replace(/MM/g, month).replace(/DD/g, day)
  }

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

function applyJournalTemplate(template: Template, date: string): AppliedJournalTemplate {
  const locale = getI18n().language || 'en-US'
  const dateObj = parseISODate(date)
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date())
  const dayOfWeek = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(dateObj)

  const content = template.content
    .replace(/\{\{title\}\}/g, date)
    .replace(/\{\{date(?::([^}]+))?\}\}/g, (_match, pattern: string | undefined) =>
      formatDateToken(dateObj, pattern, locale)
    )
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{day-of-week\}\}/g, dayOfWeek)

  const properties: Record<string, unknown> = {}
  for (const property of template.properties) {
    properties[property.name] = property.value
  }

  return {
    content,
    tags: [...template.tags],
    properties
  }
}

export interface UseJournalEntryResult {
  entry: JournalEntry | null
  isLoading: boolean
  loadedForDate: string | null
  error: string | null
  isSaving: boolean
  isDirty: boolean
  saveError: string | null
  externalUpdateCount: number
  updateContent: (content: string) => void
  updateTags: (tags: string[]) => void
  saveNow: () => Promise<void>
  reload: () => Promise<void>
  forceReload: () => Promise<void>
  deleteEntry: () => Promise<boolean>
  retrySave: () => Promise<void>
  dismissSaveError: () => void
}

export function useJournalEntry(date: string): UseJournalEntryResult {
  const queryClient = useQueryClient()

  const [isSaving, setIsSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)

  const pendingContentRef = useRef<string | null>(null)
  const pendingTagsRef = useRef<string[] | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentDateRef = useRef(date)
  const isDirtyRef = useRef(isDirty)
  const isSavingRef = useRef(false)
  const templateSeedKeyRef = useRef<string | null>(null)
  const performSaveRef = useRef<() => Promise<void>>(async () => {})
  const [isSeedingFromTemplate, setIsSeedingFromTemplate] = useState(false)

  useEffect(() => {
    isDirtyRef.current = isDirty
  }, [isDirty])

  const previousDateRef = useRef<string | null>(null)

  // Reset per-date state during render when date prop changes (React-recommended pattern
  // for "adjusting state when a prop changes", avoids no-adjust-state-on-prop-change).
  const [storedDate, setStoredDate] = useState(date)
  if (date !== storedDate) {
    setStoredDate(date)
    setIsDirty(false)
    setSaveError(null)
  }

  // Save pending content for old date before switching, and update tracking refs.
  useEffect(() => {
    const oldDate = previousDateRef.current
    const pendingContent = pendingContentRef.current
    const pendingTags = pendingTagsRef.current

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    if (oldDate && oldDate !== date && (pendingContent !== null || pendingTags !== null)) {
      const saveInput: { date: string; content?: string; tags?: string[] } = { date: oldDate }
      if (pendingContent !== null) saveInput.content = pendingContent
      if (pendingTags !== null) saveInput.tags = pendingTags

      journalService.updateEntry(saveInput).catch((err) => {
        // The user has already navigated away — this is silent data loss.
        trackRendererError('journal_pending_save_failed', err)
        log.error(`Failed to save pending changes for ${oldDate}:`, err)
      })
    }

    currentDateRef.current = date
    previousDateRef.current = date
    pendingContentRef.current = null
    pendingTagsRef.current = null
  }, [date])

  const {
    data: entry = null,
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.entry(date),
    queryFn: () => journalService.getEntry(date),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })

  // Prefetch adjacent dates for smooth navigation
  useEffect(() => {
    const dateObj = parseISODate(date)

    for (let i = 1; i <= PREFETCH_DAYS; i++) {
      const prevDate = formatDateToISO(addDays(dateObj, -i))
      void queryClient.prefetchQuery({
        queryKey: journalKeys.entry(prevDate),
        queryFn: () => journalService.getEntry(prevDate),
        staleTime: ENTRY_STALE_TIME
      })

      const nextDate = formatDateToISO(addDays(dateObj, i))
      void queryClient.prefetchQuery({
        queryKey: journalKeys.entry(nextDate),
        queryFn: () => journalService.getEntry(nextDate),
        staleTime: ENTRY_STALE_TIME
      })
    }
  }, [date, queryClient])

  const updateMutation = useMutation({
    mutationFn: async (input: { date: string; content?: string; tags?: string[] }) => {
      return journalService.updateEntry(input)
    },
    onSuccess: (updatedEntry) => {
      queryClient.setQueryData(journalKeys.entry(updatedEntry.date), updatedEntry)
      const year = parseInt(updatedEntry.date.slice(0, 4), 10)
      void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  useEffect(() => {
    if (isLoading || queryError || entry !== null) return

    let cancelled = false

    void (async () => {
      try {
        const settings = await window.api.settings.getJournalSettings()
        const templateId = settings.defaultTemplate
        if (!templateId) return

        const seedKey = `${date}:${templateId}`
        if (templateSeedKeyRef.current === seedKey) return
        templateSeedKeyRef.current = seedKey
        setIsSeedingFromTemplate(true)

        const template = await getTemplate(templateId)
        if (!template) return
        if (cancelled || currentDateRef.current !== date) return

        const applied = applyJournalTemplate(template, date)
        const createdEntry = await journalService.createEntry({
          date,
          content: applied.content,
          tags: applied.tags,
          properties: applied.properties
        })

        if (cancelled) return

        queryClient.setQueryData(journalKeys.entry(createdEntry.date), createdEntry)
        const year = parseInt(createdEntry.date.slice(0, 4), 10)
        void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
      } catch (err) {
        trackRendererError('journal_template_seed_failed', err)
        log.error('Failed to seed journal entry from default template:', err)
      } finally {
        if (!cancelled) {
          setIsSeedingFromTemplate(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [date, entry, isLoading, queryClient, queryError])

  const deleteMutation = useMutation({
    mutationFn: async (dateToDelete: string) => {
      return journalService.deleteEntry(dateToDelete)
    },
    onSuccess: (_, dateToDelete) => {
      queryClient.setQueryData(journalKeys.entry(dateToDelete), null)
      const year = parseInt(dateToDelete.slice(0, 4), 10)
      void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  const performSave = useCallback(async () => {
    const content = pendingContentRef.current
    const tags = pendingTagsRef.current
    const currentDate = currentDateRef.current

    if (content === null && tags === null) return
    if (isSavingRef.current) return

    isSavingRef.current = true
    setIsSaving(true)

    try {
      const updateInput: { date: string; content?: string; tags?: string[] } = {
        date: currentDate
      }
      if (content !== null) updateInput.content = content
      if (tags !== null) updateInput.tags = tags

      await updateMutation.mutateAsync(updateInput)

      if (currentDateRef.current === currentDate) {
        setIsDirty(false)
        setSaveError(null)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    } catch (err) {
      trackRendererError('journal_save_failed', err)
      log.error('Failed to save journal entry:', err)
      const errorMessage = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToSaveJournalEntry')
      )
      const isDiskError =
        errorMessage.includes('ENOSPC') ||
        errorMessage.includes('disk') ||
        errorMessage.includes('space') ||
        errorMessage.includes('write')
      if (currentDateRef.current === currentDate) {
        setSaveError(isDiskError ? 'Unable to save: disk may be full' : errorMessage)
      }
    } finally {
      isSavingRef.current = false
      if (currentDateRef.current === currentDate) {
        setIsSaving(false)
      }
    }
  }, [updateMutation])

  performSaveRef.current = performSave

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = setTimeout(() => {
      void performSave()
    }, AUTO_SAVE_DELAY_MS)
  }, [performSave])

  const updateContent = useCallback(
    (content: string) => {
      pendingContentRef.current = content
      setIsDirty(true)
      scheduleSave()
    },
    [scheduleSave]
  )

  const updateTags = useCallback(
    (tags: string[]) => {
      queryClient.setQueryData(
        journalKeys.entry(currentDateRef.current),
        (old: JournalEntry | undefined) => (old ? { ...old, tags } : old)
      )
      pendingTagsRef.current = tags
      setIsDirty(true)
      void performSave()
    },
    [queryClient, performSave]
  )

  const saveNow = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await performSave()
  }, [performSave])

  const reload = useCallback(async () => {
    if (isDirtyRef.current) {
      await saveNow()
    }
    await refetch()
  }, [saveNow, refetch])

  const forceReload = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    pendingContentRef.current = null
    pendingTagsRef.current = null
    setIsDirty(false)
    await refetch()
  }, [refetch])

  const deleteEntry = useCallback(async (): Promise<boolean> => {
    try {
      const result = await deleteMutation.mutateAsync(date)
      if (result.success) {
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
      return result.success
    } catch (err) {
      trackRendererError('journal_delete_failed', err)
      log.error('Failed to delete journal entry:', err)
      return false
    }
  }, [date, deleteMutation])

  const retrySave = useCallback(async () => {
    setSaveError(null)
    await performSave()
  }, [performSave])

  const dismissSaveError = useCallback(() => {
    setSaveError(null)
  }, [])

  // Save registry + unmount flush
  useEffect(() => {
    const registryKey = `journal:${date}`

    registerPendingSave(registryKey, async () => {
      if (pendingContentRef.current !== null || pendingTagsRef.current !== null) {
        await performSaveRef.current()
      }
    })

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (pendingContentRef.current !== null || pendingTagsRef.current !== null) {
        void performSaveRef.current()
      }
      unregisterPendingSave(registryKey)
    }
  }, [date])

  // External update subscriptions
  useEffect(() => {
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      if (event.date === currentDateRef.current) {
        queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const isExternal = (event as { source?: string }).source === 'external'

      if (!isExternal && isSavingRef.current) return

      if (event.date === currentDateRef.current) {
        if (isExternal) {
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
          setIsDirty(false)
          pendingContentRef.current = null
          pendingTagsRef.current = null
          setExternalUpdateCount((c) => c + 1)
        } else if (!isDirtyRef.current) {
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
        }
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      if (event.date === currentDateRef.current) {
        queryClient.setQueryData(journalKeys.entry(event.date), null)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    })

    const unsubscribeExternal = onJournalExternalChange((event) => {
      if (event.date === currentDateRef.current) {
        if (event.type === 'deleted') {
          queryClient.setQueryData(journalKeys.entry(event.date), null)
          setIsDirty(false)
        } else if (event.type === 'modified' && !isDirtyRef.current) {
          void queryClient.invalidateQueries({ queryKey: journalKeys.entry(event.date) })
        }
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
      unsubscribeExternal()
    }
  }, [queryClient])

  const loadedForDateResult = isLoading || isSeedingFromTemplate ? null : date

  return {
    entry,
    isLoading: isLoading || isSeedingFromTemplate,
    loadedForDate: loadedForDateResult,
    error: queryError ? extractErrorMessage(queryError) : null,
    isSaving,
    isDirty,
    saveError,
    externalUpdateCount,
    updateContent,
    updateTags,
    saveNow,
    reload,
    forceReload,
    deleteEntry,
    retrySave,
    dismissSaveError
  }
}
