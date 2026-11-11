import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { NoteUpdateResponse } from '@memry/contracts/notes-api'
import { useNote, useNoteMutations, type UseNoteResult } from '@/hooks/use-notes-query'
import {
  notesService,
  onNoteEventsDropped,
  onNoteUpdated,
  type Note,
  type NoteSaveResponse
} from '@/services/notes-service'
import { subscribeToEvents } from '@/services/tauri-event'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { contentHash } from '@/lib/content-hash'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useIsNoteLocked } from '@/lib/vault-locks-store'
import { useIsNoteExcluded } from '@/lib/excluded-notes-store'
import { useReplacedOutsideEdit } from './use-replaced-outside-edit'

const log = createLogger('NoteBody')

/**
 * The editors that save a note's whole body, each with its own save registry key, and the
 * telemetry action of a failed save where it had one.
 */
const SURFACES = {
  'note-page': undefined,
  'canvas-card': 'canvas_card_note_save',
  'project-overview': 'project_overview_note_save'
} as const

export type NoteBodySurface = keyof typeof SURFACES

const SAVE_DEBOUNCE_MS = 1000

/**
 * The body a save of `markdown` left in the file, as its event will say. Not `result.note`: the
 * note is read after the save and can hold a later edit (a tag's template, an outside edit).
 */
const savedText = (markdown: string, result: NoteUpdateResponse): string =>
  result.savedContent ?? markdown

/** What came in while saves of the editor's text ran (#3967). */
interface SaveWindow {
  /** The note the saves write. */
  noteId: string
  /** Saves running. */
  inFlight: number
  /** Saves started, numbering each one. */
  started: number
  /** The newest save that answered: an older reply after it does not move the baseline. */
  answered: number
  /** The text the editor's baseline held when the first save started. */
  base: string
  /** The texts the saves left in the file. */
  own: Set<string>
  /** Every text an event or a read gave meanwhile, in order. */
  outside: string[]
  /** Note events were dropped meanwhile. */
  dropped: boolean
  /** A save's reply already told the user it went over an outside edit. */
  toasted: boolean
  /**
   * The saves whose replaced file the core kept as a version, by the hash of its body
   * (`keptReplacedHash`): only the one that kept a text may tell of it (#4110, #4137).
   */
  kept: Map<string, { markdown: string; result: NoteSaveResponse }>
}

export interface NoteBodyOptions {
  /** Which editor this is: its save registry key and its failed saves' telemetry. */
  surface: NoteBodySurface
  /** Opens the note's version history, from the toast that says typing replaced an outside edit. */
  showVersionHistory: () => void
  /** The note was deleted: typing is not saved. */
  deleted?: boolean
  /** A save of the editor's text landed. */
  onSaved?: () => void
}

export interface NoteBody {
  /** The note, read again on mount (`readOnMount`). */
  query: UseNoteResult
  /**
   * The owner locked the note or a folder above it (#2606), or its file is under an exclude
   * pattern, which the core refuses every app write to (#3530): the editor takes no typing.
   */
  locked: boolean
  /** The note is read-only because it is excluded, not locked. */
  excluded: boolean
  /** The text the editor opens on: the note's, or the outside edit it was handed since. */
  content: string
  /** Bumped when `content` is an outside edit for the live editor (`externalContentRevision`). */
  revision: number
  /** The editor's `onMarkdownChange`: saves its text after a pause. */
  onMarkdownChange: (markdown: string) => void
  /** A version was restored over the note: its typing is dropped, and the editor takes the file. */
  dropTyping: () => void
}

/**
 * The whole-markdown saves of one editor of a note's body (#3967, #4088): the note page, an
 * active canvas card and a project's overview note. The editor's baseline is the file text it
 * shows: seeded once per note from its first read, moved by an outside edit it takes and by the
 * text a save left in the file. An outside edit reaches the live editor through `revision`;
 * typing not saved yet holds it off, and its save then tells the user it went over the edit. A
 * refused save writes nothing: its typing stays pending, and the user is told.
 */
export function useNoteBody(noteId: string | undefined, options: NoteBodyOptions): NoteBody {
  const { surface, showVersionHistory, deleted = false } = options
  const { t } = useT('notes')
  const query = useNote(noteId ?? null, { readOnMount: true })
  const { note, isFetching, isFetchedAfterMount } = query
  const excluded = useIsNoteExcluded(note?.path)
  const locked = useIsNoteLocked(noteId ?? null, note?.path ?? null) || excluded
  const { updateNote } = useNoteMutations()
  const outsideEdit = useReplacedOutsideEdit(noteId, note?.title, showVersionHistory)
  // Names this editor's saves: a file another editor of the note saved is not this one's own,
  // so the core keeps it before this one's save replaces it, however small (#4137).
  const [editor] = useState(() => crypto.randomUUID())
  const onSavedRef = useRef(options.onSaved)
  // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
  onSavedRef.current = options.onSaved

  const [externalUpdateCount, setExternalUpdateCount] = useState(0)
  const [eventContentOverride, setEventContentOverride] = useState<{
    noteId: string
    content: string
  } | null>(null)
  const [storedNoteIdForContent, setStoredNoteIdForContent] = useState(noteId)
  if (storedNoteIdForContent !== noteId) {
    setStoredNoteIdForContent(noteId)
    setEventContentOverride(null)
  }

  let content = note?.content ?? ''
  if (eventContentOverride !== null && eventContentOverride.noteId === noteId) {
    content = eventContentOverride.content
  }

  // A refused save wrote nothing: its typing stays the editor's, unsaved, and the user is told.
  // `closed`: the editor that held the typing is gone, so nothing tries again.
  const tRef = useRef(t)
  // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
  tRef.current = t
  const notSaved = useCallback(
    (id: string, error: unknown, refusal?: NoteUpdateResponse, closed = false) => {
      log.error('The note was not saved:', { surface, noteId: id, error, closed })
      const action = SURFACES[surface]
      if (action) trackRendererError(action, error)
      // A refusal that says why the note cannot be written is shown as that. The reply of a
      // `note_excluded` refusal carries its text (`errors:note.excluded`, #4098).
      let why = tRef.current(closed ? 'page.toast.notSavedClosed' : 'page.toast.notSaved')
      if (refusal?.code === 'note_locked') why = tRef.current('errors:vaultLock.noteReadOnly')
      if (refusal?.code === 'note_excluded' && refusal.error) why = refusal.error
      toast.error(why, { id: `note-not-saved:${id}` })
    },
    [surface]
  )

  const lastSavedContent = useRef<string>('')

  // Refs for debouncing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingMarkdownRef = useRef<string | null>(null)
  // The note whose save lifecycle is running: registered below, cleared when
  // its cleanup has flushed. The editor's teardown flush reports its last edit
  // after that cleanup (#1900), so an edit for a note that is no longer live
  // must not land in the refs above, which now belong to the next note.
  const liveNoteIdRef = useRef<string | null>(null)

  // ============================================================================
  // lastSavedContent: the file text the editor shows. Set from the note it opened
  // with, an outside edit it took, and the file a save of its text left.
  // ============================================================================

  // Only the note's first read for this page seeds it. A later read can see an outside
  // edit whose event has not arrived yet; taken here, that event would read as text the
  // editor already shows and be dropped, and the next save would write over it (#3967).
  const seededRef = useRef<{ noteId: string; content: string } | null>(null)
  // The note's events went live before its first read answered: the read again they ask for waits
  // for that answer, which is the baseline it compares with.
  const readAgainOnSeedRef = useRef<(() => void) | null>(null)
  const loadedNoteId = note?.id
  const noteContentForLastSaved = note?.content
  useEffect(() => {
    if (loadedNoteId === undefined || noteContentForLastSaved === undefined) return
    if (seededRef.current?.noteId === loadedNoteId) return
    seededRef.current = { noteId: loadedNoteId, content: noteContentForLastSaved }
    lastSavedContent.current = noteContentForLastSaved
    const readAgain = readAgainOnSeedRef.current
    readAgainOnSeedRef.current = null
    readAgain?.()
  }, [loadedNoteId, noteContentForLastSaved])

  // While saves of the editor's text run, a save cannot tell its own echo from an outside edit:
  // what comes in is kept in the save window and settled when the last save ends.
  const saveWindowRef = useRef<SaveWindow | null>(null)

  // The editor takes an outside edit's text. Typing not saved yet is the user's newest text:
  // its save follows and says it went over this one (`outsideEdit`).
  const takeContent = useCallback(
    (text: string) => {
      if (!noteId) return
      if (pendingMarkdownRef.current !== null) {
        outsideEdit.held(noteId, text)
        return
      }
      lastSavedContent.current = text
      setEventContentOverride({ noteId, content: text })
      setExternalUpdateCount((c) => c + 1)
    },
    [noteId, outsideEdit]
  )

  // The note's text as an event or a read gave it; `null` when events were dropped.
  const outsideText = useCallback(
    (text: string | null) => {
      const window = saveWindowRef.current
      // Saves of a note the page showed before keep no text of this one.
      if (window && window.noteId === noteId) {
        if (text === null) window.dropped = true
        else window.outside.push(text)
        return
      }
      if (text !== null && text !== lastSavedContent.current) takeContent(text)
    },
    [noteId, takeContent]
  )

  // The last save of a window ended. Its texts that are no save's own are outside edits, the
  // text from before the saves too (a revert); the file read again tells where they went: a
  // file that is not the newest save's text holds an edit that landed after the saves, and a
  // file at that text means a save went over them, which the user is told once when a save's
  // answer says the core kept that text as a version (#4110, #4137).
  const settleSaves = useCallback(
    (window: SaveWindow) => {
      const outside = window.outside.filter((text) => !window.own.has(text))
      if (!noteId || (!window.dropped && outside.length === 0)) return
      const saved = lastSavedContent.current
      notesService
        .get(noteId)
        .then((fresh) => {
          if (!fresh || fresh.contentOmitted || lastSavedContent.current !== saved) return
          if (fresh.content !== saved) {
            outsideText(fresh.content)
            return
          }
          // The late echo of the save before the window is no edit to tell about.
          const last = outside.findLast((text) => text !== window.base)
          if (last === undefined || window.toasted) return
          const kept = window.kept.get(contentHash(last))
          if (!kept) return
          outsideEdit.held(noteId, last)
          outsideEdit.saved(noteId, kept.markdown, kept.result)
        })
        .catch((readError: unknown) => log.warn('the note was not read again', readError))
    },
    [noteId, outsideEdit, outsideText]
  )

  // A save of the note writes over text the editor never showed: the outside edit its typing
  // held off, or one that came in while its saves ran. The core keeps that file as a version
  // however small the change (`keepReplaced`), as the toast that follows says.
  const overUnseen = useCallback(
    (id: string): boolean => {
      const window = saveWindowRef.current
      if (outsideEdit.holds(id)) return true
      if (window?.noteId !== id) return false
      return window.dropped || window.outside.some((text) => !window.own.has(text))
    },
    [outsideEdit]
  )

  // Stable ref so cleanup can always call the latest mutateAsync
  const updateNoteRef = useRef(updateNote.mutateAsync)
  // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
  updateNoteRef.current = updateNote.mutateAsync

  // One save of the editor's text. `answered` runs on the reply, before the window settles.
  const saveText = useCallback(
    async (
      markdown: string,
      answered: (result: NoteUpdateResponse) => void
    ): Promise<NoteUpdateResponse> => {
      const id = noteId ?? ''
      // A save of the note the page showed before keeps its own window.
      if (saveWindowRef.current?.noteId !== id) {
        saveWindowRef.current = {
          noteId: id,
          inFlight: 0,
          started: 0,
          answered: 0,
          base: lastSavedContent.current,
          own: new Set(),
          outside: [],
          dropped: false,
          toasted: false,
          kept: new Map()
        }
      }
      const window = saveWindowRef.current
      const keepReplaced = overUnseen(id)
      window.inFlight += 1
      const order = (window.started += 1)
      try {
        const input = { id, content: markdown, editor, ...(keepReplaced && { keepReplaced }) }
        const result = await updateNoteRef.current(input)
        // The page shows another note now: its baseline and typing are not this save's.
        if (liveNoteIdRef.current !== id) {
          if (result.success) outsideEdit.saved(id, markdown, result)
          else notSaved(id, result.error, result, true)
          return result
        }
        // A refused save wrote nothing: the editor's text is still not the file's.
        if (result.success) {
          const text = savedText(markdown, result)
          window.own.add(text)
          if (order > window.answered) {
            window.answered = order
            lastSavedContent.current = text
          }
        } else {
          notSaved(id, result.error, result)
        }
        window.toasted = outsideEdit.saved(id, markdown, result) || window.toasted
        if (result.keptReplacedHash) window.kept.set(result.keptReplacedHash, { markdown, result })
        answered(result)
        return result
      } finally {
        window.inFlight -= 1
        if (window.inFlight === 0) {
          if (saveWindowRef.current === window) saveWindowRef.current = null
          if (liveNoteIdRef.current === id) settleSaves(window)
        }
      }
    },
    // oxlint-disable-next-line react/memo-dependencies -- dependency list is intentional; the compiler trace misreads the reply handled in `try`/`finally` (`settleSaves` runs there)
    [noteId, editor, outsideEdit, settleSaves, notSaved, overUnseen]
  )

  // A save after the note's save lifecycle ended: nothing is left to keep its typing if it is
  // refused, so the user is told. One that went over an outside edit says so, as a live save does.
  const saveDetached = useCallback(
    (id: string, markdown: string) => {
      const keepReplaced = overUnseen(id)
      // The typing is gone with its editor, and with it the reason to hold an outside edit.
      const refused = (error: unknown, refusal?: NoteUpdateResponse): void => {
        outsideEdit.take(id)
        notSaved(id, error, refusal, true)
      }
      updateNoteRef
        .current({ id, content: markdown, editor, ...(keepReplaced && { keepReplaced }) })
        .then((result) => {
          if (result.success) outsideEdit.saved(id, markdown, result)
          else refused(result.error, result)
          return undefined
        })
        .catch((err: unknown) => refused(err))
    },
    [editor, notSaved, outsideEdit, overUnseen]
  )

  // A note opened from the query's cache shows the cache's text until its read on mount
  // (`readOnMount`) answers. An outside edit made while no page had the note open sends this
  // one no event, so that answer is its only news.
  const checkedNoteIdRef = useRef<string | null>(null)
  useEffect(() => {
    const seed = seededRef.current
    if (!note || !isFetchedAfterMount || isFetching || seed?.noteId !== note.id) return
    if (checkedNoteIdRef.current === note.id) return
    checkedNoteIdRef.current = note.id
    if (note.contentOmitted || note.content === seed.content) return
    if (lastSavedContent.current !== seed.content) return
    // oxlint-disable-next-line react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-pass-ref-to-parent -- an outside edit handed to the live editor once per note; whether it is taken or held depends on refs (typing, a save in flight) a render cannot read
    outsideText(note.content)
  }, [note, isFetchedAfterMount, isFetching, outsideText])

  // The note turned read-only (a lock) with typing its save has not written: that save will be
  // refused, so the user is told now. The typing stays pending, and in the editor.
  const wasLockedRef = useRef(locked)
  useEffect(() => {
    const turned = locked && !wasLockedRef.current
    wasLockedRef.current = locked
    if (!turned || !noteId || pendingMarkdownRef.current === null) return
    toast.error(tRef.current('page.toast.readOnlyUnsaved'), { id: `note-not-saved:${noteId}` })
  }, [locked, noteId])

  // Register with save registry + flush on unmount
  useEffect(() => {
    if (!noteId) return undefined

    const registryKey = `${surface}:${noteId}`
    liveNoteIdRef.current = noteId

    const flush = async (): Promise<void> => {
      // The debounced save would write the same typing again, over whatever lands after this.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      const pending = pendingMarkdownRef.current
      if (pending !== null) {
        pendingMarkdownRef.current = null
        await saveText(pending, (result) => {
          // A refused save leaves the typing to the next save, unless newer typing replaced it.
          if (!result.success) pendingMarkdownRef.current ??= pending
        })
      }
    }
    registerPendingSave(registryKey, flush)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }

      const pending = pendingMarkdownRef.current
      if (pending !== null) {
        pendingMarkdownRef.current = null
        saveDetached(noteId, pending)
      }

      // Another editor of the note on this surface may have registered since: its flush stays.
      unregisterPendingSave(registryKey, flush)
      liveNoteIdRef.current = null
    }
  }, [noteId, surface, saveText, saveDetached])

  // Listen for note updates that did not originate from this editor instance.
  useEffect(() => {
    if (!noteId) return undefined

    const onUpdated = (event: { id: string; changes: Partial<Note>; source?: string }): void => {
      if (event.id !== noteId) return

      // `sync` means the CRDT write-back rewrote the file from the Y.Doc. The
      // IPC CRDT provider has already applied those bytes to this editor, so a
      // remount here would add nothing — and write-back also fires for local
      // typing (500ms debounce, ahead of the 1000ms save), where it would blow
      // away the editor mid-keystroke.
      if (event.source === 'sync') return

      if (typeof event.changes.content !== 'string') return
      outsideText(event.changes.content)
    }

    // A missed event may have been an outside edit of this note: its text is read again. The
    // text the editor holds is taken when the read starts, so a save that lands during the read
    // is told apart from it.
    const readAgain = (): void => {
      if (saveWindowRef.current?.noteId === noteId) {
        outsideText(null)
        return
      }
      const shown = lastSavedContent.current
      notesService
        .get(noteId)
        .then((fresh) => {
          if (!fresh || fresh.contentOmitted || fresh.content === shown) return
          // A save that finished during the read wrote newer text than the read saw.
          const saved = lastSavedContent.current
          if (saved !== shown && saved !== fresh.content) return
          takeContent(fresh.content)
        })
        .catch((readError: unknown) => log.warn('the note was not read again', readError))
    }

    // Missed events: dropped ones, and those sent before the listeners went live, after the
    // note's first read (#4270). Before that read answers, the editor has no text to compare.
    const stop = subscribeToEvents(
      [(live) => onNoteUpdated(onUpdated, live), (live) => onNoteEventsDropped(readAgain, live)],
      () => {
        if (seededRef.current?.noteId === noteId) readAgain()
        else readAgainOnSeedRef.current = readAgain
      }
    )

    return () => {
      stop()
      readAgainOnSeedRef.current = null
    }
  }, [noteId, takeContent, outsideText])

  // Debounced save on markdown content change
  const onMarkdownChange = useCallback(
    (markdown: string) => {
      if (!noteId || !note) return

      // A late edit from an editor torn down after this note's save lifecycle
      // ended. Nothing is left to debounce it or flush it on quit, so it is
      // saved now, to the note it was typed in.
      if (liveNoteIdRef.current !== noteId) {
        if (deleted) return
        saveDetached(noteId, markdown)
        return
      }

      // Block saves if note was deleted
      if (deleted) {
        toast.error(t('page.toast.cannotSaveDeleted'))
        return
      }

      // Skip if content hasn't changed
      if (markdown === lastSavedContent.current) return

      pendingMarkdownRef.current = markdown

      // Clear previous timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      const armSave = (): void => {
        saveTimeoutRef.current = setTimeout(() => {
          saveTimeoutRef.current = null
          void (async () => {
            try {
              await saveText(markdown, (result) => {
                // Nothing was written: the typing stays pending for the next save or flush.
                if (!result.success) return
                setEventContentOverride(null)
                // Typing that came in while this save ran is still unsaved.
                if (pendingMarkdownRef.current === markdown) pendingMarkdownRef.current = null
                onSavedRef.current?.()
              })
            } catch (err) {
              log.error('Failed to save note, trying again:', err)
              // Unless newer typing has its own save, or the note's lifecycle has flushed.
              const unsaved = pendingMarkdownRef.current === markdown
              if (unsaved && !saveTimeoutRef.current && liveNoteIdRef.current === noteId) armSave()
            }
          })()
        }, SAVE_DEBOUNCE_MS)
      }
      armSave()
    },
    [noteId, note, deleted, t, saveText, saveDetached]
  )

  // A restored version replaced the note: a save of the typing would write over it. The
  // restore's event may have come first and been held off by the typing; the editor takes it.
  const dropTyping = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    pendingMarkdownRef.current = null
    const held = noteId === undefined ? undefined : outsideEdit.take(noteId)
    if (held !== undefined) takeContent(held)
  }, [noteId, outsideEdit, takeContent])

  return {
    query,
    locked,
    excluded,
    content,
    revision: externalUpdateCount,
    onMarkdownChange,
    dropTyping
  }
}
