import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import {
  useVaultWorkspaceLifecycle,
  type VaultWorkspaceLifecycle
} from '@/lib/vault-workspace-lifecycle'
import { getVaultSwitchState } from '@/lib/vault-switch-state'
import { getCachedVaultStatus } from '@/lib/vault-status-cache'
import { useVaultScope } from '@/contexts/vault-scope'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  JournalEntry,
  JournalEntryCreatedEvent,
  JournalEntryDeletedEvent,
  JournalEntryUpdatedEvent,
  JournalExternalChangeEvent
} from '../../../preload/index.d'
import {
  journalService,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  onJournalEntryCreated,
  onJournalEventsDropped
} from '@/services/journal-service'
import { subscribeToEvents } from '@/services/tauri-event'
import { getTemplate, type Template } from '@/services/templates-service'
import { addDays, formatDateToISO, parseISODate } from '@/lib/journal-utils'
import { resolveJournalTemplateId } from '@/lib/journal-template-resolution'
import { resolveRandomLines } from '@/lib/journal-random-line'
import {
  applyJournalTemplate as applyTemplateTokens,
  type AppliedJournalTemplate
} from '@memry/domain-notes/journal'
import {
  journalKeys,
  ENTRY_STALE_TIME,
  ENTRY_GC_TIME,
  AUTO_SAVE_DELAY_MS,
  PREFETCH_DAYS
} from './journal-query-keys'
import { mergeInlineTagEdits, type InlineTagEdit } from './use-inline-tag-edits'
import { getI18n } from 'react-i18next'
import { notesService } from '@/services/notes-service'

const log = createLogger('Hook:JournalEntry')

/** Why the save of a day no longer open was refused (main says why, a held journal folder among them). */
function savedElsewhereError(err: unknown): string {
  return extractErrorMessage(
    err,
    getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToSaveJournalEntry')
  )
}

interface PendingTagsEdit {
  tags?: string[]
  inlineTags?: InlineTagEdit
}

type JournalSaveInput = { date: string; content?: string } & PendingTagsEdit

/** How long a write of a day waits for the day's write before it, which may never answer. */
const DAY_WRITE_WAIT_MS = 10_000

type DayWriteWaiter = 'next write' | 'read' | 'save flag'

/** Each day's writes sent, the text of the last one that carried text, and those not answered. */
interface DaySends {
  sent: number
  text: string | null
  unanswered: Set<Promise<unknown>>
}

/**
 * Whether `write` answered within `DAY_WRITE_WAIT_MS` (its failure rejects): a write that never
 * answers would otherwise hold the day's later writes, its reread, and the save flag every day's
 * saves wait on. `timedOut` runs when the wait ends without it (#4138).
 */
function answeredInTime(write: Promise<unknown>, timedOut: () => void): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      timedOut()
      resolve(false)
    }, DAY_WRITE_WAIT_MS)
  })
  return Promise.race([write.then(() => true as const), waited]).finally(() => clearTimeout(timer))
}

/**
 * Whether two texts of a day are the same once trimmed, line ends aside: a save of one over the
 * other keeps the file's bytes (`journal/update.rs`, `FileChange::text`).
 */
function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n').trim() === b.replaceAll('\r\n', '\n').trim()
}

/**
 * Whether the vault this journal renders is no longer the open one. Saves are
 * addressed by date only, so a save issued from a hidden workspace's cleanup
 * (which runs after main has opened the next vault) would overwrite that
 * vault's entry for the same day. Outside any workspace (scope null) the
 * journal always belongs to the open vault.
 */
function hasLeftVault(lifecycle: VaultWorkspaceLifecycle | null, vaultScope: string | null) {
  if (lifecycle?.hidden) return true
  if (vaultScope === null) return false
  const pending = getVaultSwitchState().pending
  if (pending && pending.path !== vaultScope) return true
  const openPath = getCachedVaultStatus()?.path ?? null
  return openPath !== null && openPath !== vaultScope
}

/**
 * Seed text for a day from its template. The token substitution is
 * `@memry/domain-notes/journal`'s, shared with the iOS core through vectors;
 * only the locale formatting (`Intl`) happens here.
 */
function applyJournalTemplate(template: Template, date: string): AppliedJournalTemplate {
  const locale = getI18n().language || 'en-US'
  const dateObj = parseISODate(date)
  return applyTemplateTokens(template, date, {
    longDate: new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(dateObj),
    time: new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date()),
    dayOfWeek: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(dateObj)
  })
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
  updateInlineTags: (edit: InlineTagEdit) => void
  saveNow: () => Promise<void>
  reload: () => Promise<void>
  forceReload: () => Promise<void>
  /** `error`: why the day stayed, when it says. */
  deleteEntry: () => Promise<{ success: boolean; error?: string }>
  retrySave: () => Promise<void>
  dismissSaveError: () => void
}

export function useJournalEntry(date: string): UseJournalEntryResult {
  const queryClient = useQueryClient()
  const lifecycle = useVaultWorkspaceLifecycle()
  const vaultScope = useVaultScope()

  const [isSaving, setIsSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)

  const pendingContentRef = useRef<string | null>(null)
  const pendingTagsRef = useRef<PendingTagsEdit | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentDateRef = useRef(date)
  // The date whose save lifecycle is running: set by the registry effect below,
  // cleared by its cleanup once that date's pending save has been flushed.
  const liveDateRef = useRef<string | null>(null)
  const isDirtyRef = useRef(isDirty)
  const isSavingRef = useRef(false)
  // The running performSave, so the pre-switch flush can wait for it instead
  // of returning while its edits (or newer ones) are still unsaved.
  // Resolves with whether the save wrote.
  const inFlightSaveRef = useRef<Promise<boolean> | null>(null)
  const templateSeedKeyRef = useRef<string | null>(null)
  // Separate from the success latch above: the latch must only be set once an
  // entry actually exists, but the effect can re-run while the async seed is
  // still in flight and must not start a second one.
  const templateSeedInFlightRef = useRef<string | null>(null)
  const performSaveRef = useRef<() => Promise<void>>(async () => {})
  // What the running save writes, and to which day. The pending refs, as the save took them.
  const savingRef = useRef<{
    date: string
    content: string | null
    tags: PendingTagsEdit | null
  } | null>(null)
  // The day an outside edit or a dropped-events signal reached while its save ran: the save may
  // have written before that edit or after it, so the day is read again once it ends (#3967).
  const outsideDuringSaveRef = useRef<string | null>(null)
  // The text the open day's editor holds: what it loaded, what it reported, or the outside text
  // it was handed. Not the query's data, which the app-level listener (`useJournalChangeEvents`)
  // refetches ahead of the editor. `null` until the day has loaded.
  const editorTextRef = useRef<{ date: string; text: string } | null>(null)
  // Counts the saves started and the outside texts handed to the editor: a read of the day
  // that began before either is older than what the day holds. The save's own event is not
  // counted; it comes with the save's reply, in either order.
  const dayChangesRef = useRef(0)
  // Each day's last write, until it answers. Commands run concurrently, so a write sent before
  // the one ahead of it answered could land first, and the older text would stay in the file;
  // a read of the day sent before it answered could answer the file from before it (#4088).
  const daySavesRef = useRef(new Map<string, Promise<unknown>>())
  // Past the wait above a newer write of a day can go out before an older one answered, which
  // may then land last (`sendDayWrite`, #4138).
  const daySendsRef = useRef(new Map<string, DaySends>())
  // Stalled writes already reported, so a stall is reported once whatever waits on it.
  const reportedStallsRef = useRef(new WeakSet<Promise<unknown>>())
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

  const dayWriteStalled = useCallback((day: string, waiting: DayWriteWaiter): void => {
    log.warn(
      `A write of ${day} has not answered in ${DAY_WRITE_WAIT_MS} ms; the ${waiting} waiting on it goes on`
    )
    const reported = reportedStallsRef.current
    const stalled = [...(daySendsRef.current.get(day)?.unanswered ?? [])].filter(
      (write) => !reported.has(write)
    )
    if (stalled.length === 0) return
    for (const write of stalled) reported.add(write)
    trackRendererError(
      'journal_day_write_timeout',
      new Error(`journal day write timeout: ${waiting}`)
    )
  }, [])

  // Sends a write of `day` once the day's writes before it answered: the day's saves, the save a
  // date switch sends for the day it left, and the editor's late report of a day it left.
  const queueDaySave = useCallback(
    <T>(day: string, write: () => Promise<T>): Promise<T> => {
      const saves = daySavesRef.current
      const previous = saves.get(day)
      const sent = (
        previous
          ? answeredInTime(previous, () => dayWriteStalled(day, 'next write'))
          : Promise.resolve()
      ).then(write)
      const done: Promise<unknown> = sent
        .catch(() => undefined)
        .finally(() => {
          if (saves.get(day) === done) saves.delete(day)
        })
      saves.set(day, done)
      return sent
    },
    [dayWriteStalled]
  )

  // Sends a write of `day` from inside `queueDaySave`. Once a write passed the wait, a newer write
  // of the day may go out before it answers; the core then runs the two in either order, each
  // replacing the file, and the older text can land last. So when a write answers after a newer
  // one went out, the day's last sent text is queued again behind the day's writes, and lands
  // last; typing newer than it has its own save. A write that fails past the wait is sent again
  // the same way when its caller stopped waiting (`callerWaits` false: the save flag's wait);
  // a caller that waits shows its own failure (#4138).
  const sendDayWrite = useCallback(
    <T>(
      day: string,
      content: string | undefined,
      send: () => Promise<T>,
      callerWaits: boolean
    ): Promise<T> => {
      const sends = daySendsRef.current
      const resend = (): void => {
        // Chosen when its turn comes: a write queued ahead of it may carry newer text.
        queueDaySave(day, async () => {
          const text = sends.get(day)?.text ?? null
          if (text === null) return undefined
          return write(text, () => journalService.updateEntry({ date: day, content: text }), true)
        })
          .then((entry) => {
            if (entry !== undefined) queryClient.setQueryData(journalKeys.entry(day), entry)
          })
          .catch((err: unknown) => {
            trackRendererError('journal_save_failed', err)
            log.error(`Failed to send the newest text of ${day} again:`, err)
            if (liveDateRef.current === day) setSaveError(savedElsewhereError(err))
            else toast.error(savedElsewhereError(err))
          })
      }
      const write = <U>(
        text: string | undefined,
        run: () => Promise<U>,
        waits: boolean
      ): Promise<U> => {
        const known = sends.get(day) ?? { sent: 0, text: null, unanswered: new Set() }
        known.sent += 1
        if (text !== undefined) known.text = text
        sends.set(day, known)
        const order = known.sent
        let late = false
        const timer = setTimeout(() => {
          late = true
        }, DAY_WRITE_WAIT_MS)
        const sent = run()
        known.unanswered.add(sent)
        const answered = (failure: { err: unknown } | null): void => {
          clearTimeout(timer)
          known.unanswered.delete(sent)
          const lateFailure = failure !== null && late && !waits
          if (lateFailure) {
            trackRendererError('journal_save_failed', failure.err)
            log.error(`A write of ${day} failed after the wait on it ended:`, failure.err)
          }
          if (known.sent !== order || lateFailure) resend()
        }
        sent.then(
          () => answered(null),
          (err: unknown) => answered({ err })
        )
        return sent
      }
      return write(content, send, callerWaits)
    },
    [queryClient, queueDaySave]
  )

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
      const saveInput: JournalSaveInput = { date: oldDate, ...pendingTags }
      if (pendingContent !== null) saveInput.content = pendingContent
      // The save running may already send these edits: the unmount flush of the save registry
      // runs before this effect and starts one. A second write of the same text could go over
      // an outside edit that landed between the two; it is sent again only if that save fails.
      const saving = savingRef.current
      const running = inFlightSaveRef.current
      const sendsThese =
        running &&
        saving?.date === oldDate &&
        saving.content === pendingContent &&
        saving.tags === pendingTags
          ? running
          : null
      // oxlint-disable react-you-might-not-need-an-effect/no-pass-ref-to-parent -- sendDayWrite is this hook's own callback, not a parent's prop or ref
      queueDaySave(oldDate, async () => {
        if (sendsThese && (await sendsThese)) return undefined
        return sendDayWrite(
          oldDate,
          saveInput.content,
          () => journalService.updateEntry(saveInput),
          true
        )
      }).catch((err: unknown) => {
        // oxlint-enable react-you-might-not-need-an-effect/no-pass-ref-to-parent
        // The user has already navigated away, so the day's save error is not on screen.
        trackRendererError('journal_pending_save_failed', err)
        log.error(`Failed to save pending changes for ${oldDate}:`, err)
        toast.error(savedElsewhereError(err))
      })
      // The day reopened before the save's reply opens on these edits, not on the cache's
      // older text, which typing then would save over.
      if (pendingContent !== null) {
        queryClient.setQueryData<JournalEntry | null>(journalKeys.entry(oldDate), (old) =>
          old ? { ...old, content: pendingContent } : old
        )
      }
    }

    currentDateRef.current = date
    previousDateRef.current = date
    pendingContentRef.current = null
    pendingTagsRef.current = null
    editorTextRef.current = null
  }, [date, queryClient, queueDaySave, sendDayWrite])

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
    mutationFn: async (input: JournalSaveInput) => {
      return journalService.updateEntry(input)
    },
    onSuccess: (updatedEntry) => {
      queryClient.setQueryData(journalKeys.entry(updatedEntry.date), updatedEntry)
      const year = parseInt(updatedEntry.date.slice(0, 4), 10)
      void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  useEffect(() => {
    if (isLoading || queryError || entry !== null) return undefined

    let cancelled = false

    void (async () => {
      try {
        const settings = await window.api.settings.getJournalSettings()
        const templateId = resolveJournalTemplateId(settings, date)
        if (!templateId) return

        const seedKey = `${date}:${templateId}`
        if (templateSeedKeyRef.current === seedKey) return
        if (templateSeedInFlightRef.current === seedKey) return
        templateSeedInFlightRef.current = seedKey
        setIsSeedingFromTemplate(true)

        // A template synced from another device can land after the settings
        // that point at it, so a miss here is transient. Leaving the success
        // latch unset lets the next effect run retry instead of stranding the
        // day blank for the rest of the session.
        const template = await getTemplate(templateId)
        if (!template) return
        if (cancelled || currentDateRef.current !== date) return

        const content = await resolveRandomLines(template.content, async (title) => {
          const target = await notesService.resolveByTitle(title)
          if (!target) return null
          return (await notesService.get(target.id))?.content ?? null
        })
        if (cancelled || currentDateRef.current !== date) return

        const applied = applyJournalTemplate({ ...template, content }, date)
        const createdEntry = await journalService
          .createEntry({
            date,
            content: applied.content,
            tags: applied.tags,
            properties: applied.properties
          })
          .catch((err: unknown) => {
            // A refused create (main says why, settings it cannot read among them) shows as
            // the day's save error; the next visit to the day tries the template again.
            if (!cancelled && currentDateRef.current === date) {
              setSaveError(
                extractErrorMessage(
                  err,
                  getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToSaveJournalEntry')
                )
              )
            }
            throw err
          })

        if (cancelled) return

        templateSeedKeyRef.current = seedKey
        queryClient.setQueryData(journalKeys.entry(createdEntry.date), createdEntry)
        const year = parseInt(createdEntry.date.slice(0, 4), 10)
        void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
      } catch (err) {
        trackRendererError('journal_template_seed_failed', err)
        log.error('Failed to seed journal entry from template:', err)
      } finally {
        templateSeedInFlightRef.current = null
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
    onSuccess: (result, dateToDelete) => {
      // A day the user kept (`deleteEntry`) is still there.
      if (!result.success) return
      queryClient.setQueryData(journalKeys.entry(dateToDelete), null)
      const year = parseInt(dateToDelete.slice(0, 4), 10)
      void queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  // Reads the open day again and hands a text other than the editor's to it, as an outside
  // edit's event does. The read is dropped when the day holds typing not saved yet by the time it
  // lands, or when a save or an outside edit came since it began: either is newer than it.
  // Callers wait for a save of the day that is running (`outsideDuringSaveRef`); the read waits
  // for every write of the day sent before it (`queueDaySave`).
  const readDayAgain = useCallback(
    (day: string) => {
      // Taken now: a save started while the read waits for the day's writes is newer than it.
      const asked = dayChangesRef.current
      const read = (open: string): void => {
        const queryKey = journalKeys.entry(open)
        journalService
          .getEntry(open)
          .then((fetched) => {
            const holdsText = pendingContentRef.current !== null || pendingTagsRef.current !== null
            if (currentDateRef.current !== open || holdsText) return
            if (dayChangesRef.current !== asked) return
            const held = editorTextRef.current
            const shown =
              held?.date === open
                ? held.text
                : (queryClient.getQueryData<JournalEntry | null>(queryKey)?.content ?? '')
            const text = fetched?.content ?? ''
            queryClient.setQueryData(queryKey, fetched)
            if (sameText(text, shown)) return
            editorTextRef.current = { date: open, text }
            dayChangesRef.current += 1
            setExternalUpdateCount((c) => c + 1)
          })
          .catch((err: unknown) => {
            log.warn(`Failed to read ${open} again after an outside change:`, err)
          })
      }
      // A write past the wait answers after newer ones; its answer queues the day's newest text
      // again (`sendDayWrite`), which the read then waits for too.
      const waits: Promise<unknown>[] = [...(daySendsRef.current.get(day)?.unanswered ?? [])]
      const queued = daySavesRef.current.get(day)
      if (queued) waits.push(queued)
      if (waits.length === 0) return read(day)
      const stalled = (): void => dayWriteStalled(day, 'read')
      void answeredInTime(Promise.allSettled(waits), stalled).then((answered) => {
        const resent = daySavesRef.current.get(day)
        if (answered && resent) void answeredInTime(resent, stalled).then(() => read(day))
        else read(day)
      })
    },
    [dayWriteStalled, queryClient]
  )

  const performSave = useCallback(async () => {
    const content = pendingContentRef.current
    const tags = pendingTagsRef.current
    const currentDate = currentDateRef.current

    if (content === null && tags === null) return
    if (isSavingRef.current) return

    dayChangesRef.current += 1
    savingRef.current = { date: currentDate, content, tags }
    isSavingRef.current = true
    setIsSaving(true)

    let settle: (saved: boolean) => void = () => {}
    inFlightSaveRef.current = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    let saved = false

    try {
      const updateInput: JournalSaveInput = { date: currentDate, ...tags }
      if (content !== null) updateInput.content = content

      // A write that never answers releases the save flag; its edits stay pending for the next save.
      saved = await queueDaySave(currentDate, () =>
        answeredInTime(
          sendDayWrite(
            currentDate,
            updateInput.content,
            () => updateMutation.mutateAsync(updateInput),
            false
          ),
          () => dayWriteStalled(currentDate, 'save flag')
        )
      )

      if (saved && currentDateRef.current === currentDate) {
        setSaveError(null)
        // Edits made while this save was in flight are newer than what it
        // wrote; they stay pending for the next save.
        if (pendingContentRef.current === content) pendingContentRef.current = null
        if (pendingTagsRef.current === tags) pendingTagsRef.current = null
        if (pendingContentRef.current === null && pendingTagsRef.current === null) {
          setIsDirty(false)
        }
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
      inFlightSaveRef.current = null
      settle(saved)
      if (currentDateRef.current === currentDate) {
        setIsSaving(false)
      }
      // Typing made since, or a day the page moved to, drops the read (`readDayAgain`). The
      // typing is newer than the outside edit, and its save goes over it.
      const told = outsideDuringSaveRef.current
      outsideDuringSaveRef.current = null
      if (told !== null) readDayAgain(told)
    }
    // oxlint-disable-next-line react/memo-dependencies -- readDayAgain changes only with queryClient; listed to satisfy hooks/exhaustive-deps
  }, [dayWriteStalled, queueDaySave, readDayAgain, sendDayWrite, updateMutation])

  // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
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
      // The editor's teardown flush reports its last edit after the journal
      // has switched dates or unmounted, and after that date's pending save
      // was flushed (#1900). Queued here it would save under whatever date is
      // open now, or sit in a timer the save registry cannot see, so it is
      // saved now, to the date it was typed on.
      if (liveDateRef.current !== date) {
        if (hasLeftVault(lifecycle, vaultScope)) {
          log.warn(`Dropped a late journal edit for ${date}: its vault closed before it arrived`)
          return
        }
        queueDaySave(date, () =>
          sendDayWrite(date, content, () => updateMutation.mutateAsync({ date, content }), true)
        ).catch((err: unknown) => {
          trackRendererError('journal_pending_save_failed', err)
          log.error(`Failed to save late changes for ${date}:`, err)
          toast.error(savedElsewhereError(err))
        })
        return
      }
      // The editor reports the text it was handed (the day's load, an outside edit) as a change.
      // Text the editor already holds is nothing new to save: held as typing, it would keep the
      // next outside edit out of the day, and its save would go over that edit.
      const held = editorTextRef.current
      if (held?.date === date && sameText(content, held.text)) return
      editorTextRef.current = { date, text: content }
      pendingContentRef.current = content
      setIsDirty(true)
      scheduleSave()
    },
    [date, lifecycle, queueDaySave, scheduleSave, sendDayWrite, updateMutation, vaultScope]
  )

  const updateTags = useCallback(
    (tags: string[]) => {
      queryClient.setQueryData(
        journalKeys.entry(currentDateRef.current),
        (old: JournalEntry | undefined) => (old ? { ...old, tags } : old)
      )
      pendingTagsRef.current = { ...pendingTagsRef.current, tags }
      setIsDirty(true)
      void performSave()
    },
    [queryClient, performSave]
  )

  const updateInlineTags = useCallback(
    (edit: InlineTagEdit) => {
      const pending = pendingTagsRef.current
      const inlineTags = pending?.inlineTags ? mergeInlineTagEdits(pending.inlineTags, edit) : edit
      pendingTagsRef.current = { ...pending, inlineTags }
      setIsDirty(true)
      void performSave()
    },
    [performSave]
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
    const { data } = await refetch()
    // The page remounts the day's editor on this answer.
    if (currentDateRef.current === date) editorTextRef.current = { date, text: data?.content ?? '' }
  }, [date, refetch])

  const deleteEntry = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await deleteMutation.mutateAsync(date)
      if (result.success) {
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
      return result
    } catch (err) {
      trackRendererError('journal_delete_failed', err)
      log.error('Failed to delete journal entry:', err)
      return { success: false }
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
    liveDateRef.current = date

    // The vault switch runs this before main closes the vault, and the unmount below, so it
    // must leave nothing pending: a save already in flight would make performSave return
    // early, and edits typed during it would stay unsaved.
    // `unmounted`: the unmount's own flush, during whose wait a switch can name or open the next
    // vault. The switch's flush, run before main closes this vault, saves the edits then.
    const flush = async (unmounted = false): Promise<void> => {
      while (inFlightSaveRef.current) await inFlightSaveRef.current
      if (pendingContentRef.current === null && pendingTagsRef.current === null) return
      if (unmounted && hasLeftVault(lifecycle, vaultScope)) {
        log.warn(`Skipped saving journal edits for ${date}: its vault closed during the last save`)
        return
      }
      await performSaveRef.current()
      // A failed save keeps its text pending; the caller must not act as if it were on disk.
      if (pendingContentRef.current !== null || pendingTagsRef.current !== null) {
        throw new Error(`journal edits for ${date} are still unsaved`)
      }
    }
    registerPendingSave(registryKey, flush)

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (pendingContentRef.current !== null || pendingTagsRef.current !== null) {
        if (hasLeftVault(lifecycle, vaultScope)) {
          // Hiding a vault's workspace runs this after the next vault is open;
          // a date-addressed save now would land in that vault's journal.
          // Pending stays set: if the workspace is shown again, the next save
          // still writes it to this vault.
          log.warn(
            `Skipped saving journal edits for ${date}: its vault closed before they were flushed`
          )
        } else {
          // Registered until it ends, so a quit waits for it. The same day opened again
          // meanwhile registers its own flush under this key.
          void flush(true)
            .catch((error: unknown) => log.warn(`Journal edits for ${date} stay unsaved`, error))
            .finally(() => unregisterPendingSave(registryKey, flush))
          liveDateRef.current = null
          return
        }
      }
      unregisterPendingSave(registryKey)
      liveDateRef.current = null
    }
  }, [date, lifecycle, vaultScope])

  // External update subscriptions
  useEffect(() => {
    const onCreated = (event: JournalEntryCreatedEvent): void => {
      if (event.date === currentDateRef.current) {
        queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
      }
    }

    const onUpdated = (event: JournalEntryUpdatedEvent): void => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- journal event payload carries an optional source tag outside the declared event type
      const isExternal = (event as { source?: string }).source === 'external'

      if (!isExternal && isSavingRef.current) return

      if (event.date === currentDateRef.current) {
        if (isExternal) {
          // The day's save running may have written before this edit or after it: settled when
          // it ends.
          if (isSavingRef.current && savingRef.current?.date === event.date) {
            outsideDuringSaveRef.current = event.date
            return
          }
          // Edits not saved yet are the user's newest; they reached no file, so nothing else
          // holds them. Their save writes over the outside edit, which the core keeps as a
          // version (`app_edit.rs`), as a note's save does.
          if (pendingContentRef.current !== null || pendingTagsRef.current !== null) return
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
          editorTextRef.current = { date: event.date, text: event.entry.content }
          dayChangesRef.current += 1
          setExternalUpdateCount((c) => c + 1)
        } else if (!isDirtyRef.current) {
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry)
          // Not this page's save, which has its reply: another page's, such as one unmounted
          // during its save that saved the typing made during it after this page opened the day.
          // A late event of an older save of its own reads the day's newest text back.
          const held = editorTextRef.current
          if (held?.date === event.date && !sameText(event.entry.content, held.text)) {
            readDayAgain(event.date)
          }
        }
      }
    }

    const onDeleted = (event: JournalEntryDeletedEvent): void => {
      if (event.date === currentDateRef.current) {
        queryClient.setQueryData(journalKeys.entry(event.date), null)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    }

    const onExternal = (event: JournalExternalChangeEvent): void => {
      if (event.date === currentDateRef.current) {
        if (event.type === 'deleted') {
          queryClient.setQueryData(journalKeys.entry(event.date), null)
          setIsDirty(false)
        } else if (event.type === 'modified' && !isDirtyRef.current) {
          void queryClient.invalidateQueries({ queryKey: journalKeys.entry(event.date) })
        }
      }
    }

    // A missed event may have changed the open day: read again once a running save ends, and
    // not while it holds unsaved text, which its save keeps, as for `modified`. New text reaches
    // the editor as an outside edit's does; the same text leaves the editor (and its cursor) as
    // it is.
    const missed = (): void => {
      const open = currentDateRef.current
      if (!open) return
      if (isSavingRef.current && savingRef.current?.date === open) {
        outsideDuringSaveRef.current = open
        return
      }
      if (isDirtyRef.current) return
      readDayAgain(open)
    }

    // Missed events: dropped ones, and those sent before the listeners went live, after the day
    // was read (#4270). A day whose editor has not opened yet is read when it opens, after this.
    return subscribeToEvents(
      [
        (live) => onJournalEntryCreated(onCreated, live),
        (live) => onJournalEntryUpdated(onUpdated, live),
        (live) => onJournalEntryDeleted(onDeleted, live),
        (live) => onJournalExternalChange(onExternal, live),
        (live) => onJournalEventsDropped(missed, live)
      ],
      () => {
        if (editorTextRef.current?.date === currentDateRef.current) missed()
      }
    )
  }, [queryClient, readDayAgain])

  const loadedForDateResult = isLoading || isSeedingFromTemplate ? null : date

  // The page mounts the day's editor with this answer once the day has loaded. A day opened from
  // the cache shows the cache's text: an outside edit made while the day was not open sent this
  // page no event (`useJournalChangeEvents` only marks it stale), so the read made once the
  // editor opens is its only news, as a note's read on mount is (#4051).
  useEffect(() => {
    // oxlint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- keeps a ref in step with the text the page mounted its editor on; no event marks the day's load
    if (loadedForDateResult !== date || editorTextRef.current?.date === date) return
    editorTextRef.current = { date, text: entry?.content ?? '' }
    // The day's own save may still run, its reply not in the cache yet: read once it ends.
    if (isSavingRef.current && savingRef.current?.date === date) outsideDuringSaveRef.current = date
    // oxlint-disable-next-line react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-chain-state-updates, react-you-might-not-need-an-effect/no-pass-ref-to-parent -- one read per day opened, handed over or not by refs (typing, a save in flight) a render cannot read, as note.tsx's read on mount
    else readDayAgain(date)
  }, [date, entry, loadedForDateResult, readDayAgain])

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
    updateInlineTags,
    saveNow,
    reload,
    forceReload,
    deleteEntry,
    retrySave,
    dismissSaveError
  }
}
