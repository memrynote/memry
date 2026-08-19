/**
 * CaptureBar — the one capture field used by Inbox, Tasks and the Project hub.
 *
 * Geometry, typography, focus treatment and keyboard contract live here and
 * nowhere else, so the three surfaces cannot drift apart again. Everything a
 * single surface needs is a capability prop: pass `attachment` and a paperclip
 * appears, pass `voice` and the mic + inline recorder appear, pass `quickAdd`
 * and `@tomorrow` / `every monday` / `!high` / `+project` / `#tag` / `[[Note]]`
 * get parsed, painted as pills, and finished by the inline ghost completion (or,
 * for `[[`, the note picker). Omit them and the affordance is not rendered at
 * all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FileText, Link as LinkIcon, Loader2, Mic, Paperclip, Send } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts-base'
import { useTrackedTimeout } from '@/hooks/use-tracked-timeout'
import { isMac } from '@/lib/shortcut-registry'
import { isLikelyUrl } from '@/lib/capture-intent'
import { hasSpecialSyntax, parseQuickAdd } from '@/lib/quick-add-parser'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { VoiceRecorder, type VoiceRecorderHandle } from '@/components/voice-recorder'
import { AutocompleteDropdown } from '@/components/tasks/quick-add/autocomplete-dropdown'
import {
  TokenOverlay,
  detectTrigger,
  predictCompletion,
  replaceTrigger
} from './capture-bar-tokens'
import { useNoteSuggestions, useTagSuggestions } from './capture-bar-suggestions'
import { ownsFocusShortcut, registerCaptureField } from './focus-shortcut-owner'
import type { Priority, RepeatConfig } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

/** Focus accent when a surface does not supply its own (Inbox's amber). */
export const CAPTURE_ACCENT_DEFAULT = '#f59e0b'

/** How long the recorder slot animates out before it unmounts. */
const RECORDER_TRANSITION_MS = 250

/** Auto-grow ceiling for the text field, in px. */
const MAX_FIELD_HEIGHT = 200

export interface CaptureBarParsed {
  dueDate: Date | null
  /** "HH:MM", only when the natural-language date carried a time. */
  dueTime: string | null
  priority: Priority
  projectId: string | null
  repeat: RepeatConfig | null
  /** Every `#tag` in the input, case preserved. */
  tags: string[]
  /** Notes named by a `[[…]]` run that resolved to a real note. */
  linkedNoteIds: string[]
}

/** How many notes the `[[` picker shows at once. */
const NOTE_PICKER_LIMIT = 10

export interface CaptureBarProps {
  placeholder: string
  /** Accessible name for the text field. */
  ariaLabel: string
  /**
   * Called with the submitted text — the parsed title when `quickAdd` is on,
   * the raw trimmed value otherwise. Return `false` to keep the text in the
   * field (the Inbox does this when the capture turns out to be a duplicate).
   */
  onSubmit: (text: string, parsed?: CaptureBarParsed) => boolean | void | Promise<boolean | void>
  /** Disables the field and the actions while the surface is working. */
  isBusy?: boolean
  /** Bump to focus the field (changes each time so it re-fires). */
  focusSignal?: number
  /** Bump to empty the field after a surface handled the text out-of-band. */
  clearSignal?: number
  /** Hex colour for the focused border and the leading icon. */
  accentColor?: string
  /** `'add'` = dashed plus, `'auto'` = link or document depending on the content. */
  icon?: 'auto' | 'add'
  /**
   * Enables quick-add parsing, pills and completion — the note editor's own
   * grammar: `@next wednesday`, `!high`, `+project`, `#tag`, `[[Note]]` and
   * `every 2 weeks`. Everything but `[[` is finished by the inline ghost.
   */
  quickAdd?: { projects: Project[] }
  /** Renders the paperclip. */
  attachment?: {
    onAttach: () => void | Promise<void>
    label: string
    title?: string
    busy?: boolean
  }
  /** Renders the mic and the inline recorder. */
  voice?: {
    onComplete: (audio: Blob, seconds: number) => void | Promise<void>
    /** Gate the recorder (permissions, model download). Return false to abort. */
    onBeforeStart?: () => boolean | Promise<boolean>
    label: string
    title?: string
    maxDuration?: number
  }
  /** Shows the ⌘↵ hint and opens a detail surface with the current text. */
  onOpenDetail?: (text: string) => void
  /** Accessible name for the submit button, derived from the current value. */
  submitLabel?: (value: string) => string
  /** Extra controls rendered inside the box, before the submit button. */
  trailing?: React.ReactNode
  /** Rendered under the box (duplicate notices and the like). */
  footer?: React.ReactNode
  className?: string
}

/** 60% opacity for a 6-digit hex; anything else is used as-is. */
function withFocusAlpha(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}99` : color
}

const DashedPlusIcon = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
    <circle
      cx="6.5"
      cy="6.5"
      r="5"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeDasharray="2.5 2.5"
    />
    <path d="M6.5 4.5v4M4.5 6.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)

export const CaptureBar = ({
  placeholder,
  ariaLabel,
  onSubmit,
  isBusy = false,
  focusSignal,
  clearSignal,
  accentColor = CAPTURE_ACCENT_DEFAULT,
  icon = 'add',
  quickAdd,
  attachment,
  voice,
  onOpenDetail,
  submitLabel,
  trailing,
  footer,
  className
}: CaptureBarProps): React.JSX.Element => {
  const { t } = useT('common')
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [caretAtEnd, setCaretAtEnd] = useState(true)
  const [isRecording, setIsRecording] = useState(false)
  const [isRecorderMounted, setIsRecorderMounted] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<VoiceRecorderHandle | null>(null)
  const recorderDismissTimerRef = useRef<number | null>(null)
  // Guards the attach button's pointerdown/click pair (see the button below).
  const attachFiredByPointerRef = useRef(false)
  // The delayed blur below must not fire after the bar is gone.
  const scheduleTimeout = useTrackedTimeout()

  const disabled = isBusy
  const trimmed = value.trim()

  // Registered for the lifetime of the bar, so `ownsFocusShortcut` can pick a
  // single winner when split view has more than one bar mounted.
  useEffect(() => registerCaptureField(() => fieldRef.current), [])

  // Memoized: an inline array would hand `useKeyboardShortcuts` a new value on
  // every render, tearing the window listener down and re-adding it on every
  // keystroke. Both callbacks read `fieldRef` at keypress time rather than
  // closing over state, so a stable array cannot go stale.
  const focusShortcuts = useMemo(
    () => [
      {
        key: 'q',
        when: () => ownsFocusShortcut(fieldRef.current),
        action: () => fieldRef.current?.focus(),
        description: t('capture.focusShortcut')
      }
    ],
    [t]
  )

  useKeyboardShortcuts(focusShortcuts)

  // Focus on demand (sidebar clicks, empty-state buttons). The signal changes
  // each time, so this re-fires even when the surface is already open.
  useEffect(() => {
    if (focusSignal) fieldRef.current?.focus()
  }, [focusSignal])

  // Adjusted during render rather than in an effect: the field must already be
  // empty on the commit that shows the surface's post-capture state.
  const [lastClearSignal, setLastClearSignal] = useState(clearSignal)
  if (clearSignal !== lastClearSignal) {
    setLastClearSignal(clearSignal)
    setValue('')
  }

  // Auto-grow up to the ceiling, then scroll. An empty field measures its
  // wrapped placeholder, so in a narrow window the bar would balloon to the
  // placeholder's height before anything is typed — stay at one row until then.
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = value ? `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT)}px` : 'auto'
  }, [value])

  const clearRecorderDismissTimer = useCallback(() => {
    if (recorderDismissTimerRef.current !== null) {
      window.clearTimeout(recorderDismissTimerRef.current)
      recorderDismissTimerRef.current = null
    }
  }, [])

  useEffect(() => clearRecorderDismissTimer, [clearRecorderDismissTimer])

  const showRecorder = useCallback(() => {
    clearRecorderDismissTimer()
    setIsRecorderMounted(true)
    setIsRecording(true)
  }, [clearRecorderDismissTimer])

  const hideRecorder = useCallback(() => {
    setIsRecording(false)
    clearRecorderDismissTimer()
    recorderDismissTimerRef.current = window.setTimeout(() => {
      setIsRecorderMounted(false)
      recorderDismissTimerRef.current = null
    }, RECORDER_TRANSITION_MS)
  }, [clearRecorderDismissTimer])

  // --------------------------------------------------------------------------
  // Inline ghost completion (quick-add only)
  // --------------------------------------------------------------------------

  // The ghost is painted at the end of the overlay, so it only tells the truth
  // while the caret is there too.
  const syncCaret = useCallback((): void => {
    const field = fieldRef.current
    if (!field) return
    setCaretAtEnd(
      field.selectionStart === field.value.length && field.selectionStart === field.selectionEnd
    )
  }, [])

  // The trigger the caret is in, shared by the ghost and the `[[` picker.
  const trigger = useMemo(
    () => (quickAdd && isFocused ? detectTrigger(value) : null),
    [quickAdd, isFocused, value]
  )

  const noteQuery = trigger?.kind === 'noteLink' ? trigger.query : null
  const notes = useNoteSuggestions(noteQuery !== null)
  const tags = useTagSuggestions(trigger?.kind === 'tag')

  const ghost = useMemo(() => {
    if (!quickAdd || !isFocused || !caretAtEnd) return null
    return predictCompletion(value, quickAdd.projects, tags)
  }, [quickAdd, isFocused, caretAtEnd, value, tags])

  const acceptGhost = useCallback((): void => {
    if (!ghost) return
    setValue((prev) => replaceTrigger(prev, ghost.start, ghost.text))
    fieldRef.current?.focus()
  }, [ghost])

  // --------------------------------------------------------------------------
  // `[[` note picker
  //
  // The one completion that is a list rather than a ghost: note titles are
  // arbitrary user data, so guessing at them would be worse than showing them.
  // --------------------------------------------------------------------------

  // Closed by Esc, re-armed by the next keystroke.
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const [pickerIndex, setPickerIndex] = useState(0)

  // What the picker has handed out, so submit links the note the user actually
  // chose rather than re-resolving a title two notes might share.
  const pickedNoteIdsRef = useRef(new Map<string, string>())

  const noteOptions = useMemo(() => {
    if (noteQuery === null) return []
    const query = noteQuery.trim()
    const matched = query ? fuzzySearch(notes, query, ['title']) : notes
    return matched
      .slice(0, NOTE_PICKER_LIMIT)
      .map((note) => ({ value: note.id, label: note.title }))
  }, [noteQuery, notes])

  // Reset the highlight during render whenever the list changes underneath it.
  const [lastNoteOptions, setLastNoteOptions] = useState(noteOptions)
  if (lastNoteOptions !== noteOptions) {
    setLastNoteOptions(noteOptions)
    setPickerIndex(0)
  }

  const isPickerOpen = noteQuery !== null && !pickerDismissed && noteOptions.length > 0

  const selectNote = useCallback(
    (noteId: string): void => {
      const note = notes.find((candidate) => candidate.id === noteId)
      if (!note || trigger?.kind !== 'noteLink') return
      pickedNoteIdsRef.current.set(note.title.toLowerCase(), note.id)
      setValue((prev) => replaceTrigger(prev, trigger.start, `[[${note.title}]]`))
      fieldRef.current?.focus()
    },
    [notes, trigger]
  )

  // A `[[Title]]` the picker wrote is already known; one typed by hand is
  // resolved against the loaded notes by exact title.
  const resolveNoteIds = useCallback(
    (titles: string[]): string[] =>
      titles
        .map((title) => {
          const key = title.toLowerCase()
          return (
            pickedNoteIdsRef.current.get(key) ??
            notes.find((note) => note.title.toLowerCase() === key)?.id ??
            null
          )
        })
        .filter((id): id is string => id !== null),
    [notes]
  )

  // --------------------------------------------------------------------------
  // Submit
  // --------------------------------------------------------------------------

  const submit = useCallback(async (): Promise<void> => {
    if (!trimmed || disabled) return

    const result = quickAdd
      ? await (async () => {
          const parsed = parseQuickAdd(trimmed, quickAdd.projects)
          return onSubmit(parsed.title, {
            dueDate: parsed.dueDate,
            dueTime: parsed.dueTime,
            priority: parsed.priority,
            projectId: parsed.projectId,
            repeat: parsed.repeat,
            tags: parsed.tags,
            linkedNoteIds: resolveNoteIds(parsed.noteTitles)
          })
        })()
      : await onSubmit(trimmed)

    // `false` means the surface wants the text left alone (duplicate, failure).
    if (result !== false) {
      setValue('')
    }
    // Keep focus for rapid entry.
    fieldRef.current?.focus()
  }, [trimmed, disabled, quickAdd, onSubmit, resolveNoteIds])

  const openDetail = useCallback((): void => {
    if (!onOpenDetail) return
    const text = quickAdd ? parseQuickAdd(trimmed, quickAdd.projects).title : trimmed
    onOpenDetail(text)
    setValue('')
    fieldRef.current?.blur()
  }, [onOpenDetail, quickAdd, trimmed])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // The `[[` picker owns the keyboard while it is open — including Enter,
      // which selects a note here rather than submitting the task.
      if (isPickerOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setPickerIndex((prev) => Math.min(prev + 1, noteOptions.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setPickerIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          selectNote(noteOptions[pickerIndex].value)
          return
        }
        // First Esc closes the list and leaves the text alone; a second one
        // clears the field, the way Esc always has.
        if (e.key === 'Escape') {
          e.preventDefault()
          setPickerDismissed(true)
          return
        }
      }

      // Tab and → accept the ghost. Enter deliberately does not: it submits
      // exactly what is on screen, so a suggestion is never captured by
      // accident.
      if (ghost && (e.key === 'Tab' || e.key === 'ArrowRight')) {
        e.preventDefault()
        acceptGhost()
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        if ((e.metaKey || e.ctrlKey) && onOpenDetail) {
          e.preventDefault()
          openDetail()
          return
        }
        e.preventDefault()
        void submit()
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setValue('')
        fieldRef.current?.blur()
      }
    },
    [
      isPickerOpen,
      noteOptions,
      pickerIndex,
      selectNote,
      ghost,
      acceptGhost,
      submit,
      onOpenDetail,
      openDetail
    ]
  )

  // --------------------------------------------------------------------------
  // Voice
  // --------------------------------------------------------------------------

  const handleMicClick = useCallback(async (): Promise<void> => {
    if (!voice) return
    if (voice.onBeforeStart && !(await voice.onBeforeStart())) return
    // The recorder has to exist before we can tell it to start.
    flushSync(showRecorder)
    void recorderRef.current?.start()
  }, [voice, showRecorder])

  const handleRecordingComplete = useCallback(
    async (audio: Blob, seconds: number): Promise<void> => {
      hideRecorder()
      await voice?.onComplete(audio, seconds)
    },
    [hideRecorder, voice]
  )

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const showTokens = Boolean(quickAdd) && (hasSpecialSyntax(value) || ghost !== null)
  const attachBusy = attachment?.busy ?? false

  const leadingIcon =
    icon === 'add' ? (
      <DashedPlusIcon />
    ) : isLikelyUrl(value) ? (
      <LinkIcon className="size-3.5" aria-hidden="true" />
    ) : (
      <FileText className="size-3.5" aria-hidden="true" />
    )

  return (
    <div className={cn('relative flex flex-col gap-2', className)}>
      <div className="flex w-full min-w-0 items-stretch">
        <div
          data-testid="capture-bar-shell"
          className={cn(
            'relative flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1',
            'border-[1.5px] border-dashed',
            'transition-[width,border-color,background-color] duration-300 ease-out',
            'motion-reduce:transition-none',
            isRecording ? 'w-[60%]' : 'w-full',
            isFocused ? 'bg-muted/10' : 'border-border hover:border-text-tertiary'
          )}
          style={isFocused ? { borderColor: withFocusAlpha(accentColor) } : undefined}
        >
          <div
            className="flex shrink-0 items-center transition-colors duration-150"
            style={{ color: isFocused ? accentColor : undefined }}
          >
            {leadingIcon}
          </div>

          <div className="relative min-w-0 flex-1">
            {showTokens && (
              <div
                ref={overlayRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[12px] leading-[18px]"
              >
                <TokenOverlay value={value} ghost={ghost?.remainder} />
              </div>
            )}
            <textarea
              ref={fieldRef}
              rows={1}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setPickerDismissed(false)
                syncCaret()
              }}
              onSelect={syncCaret}
              onScroll={() => {
                if (overlayRef.current && fieldRef.current) {
                  overlayRef.current.scrollTop = fieldRef.current.scrollTop
                }
              }}
              onFocus={() => setIsFocused(true)}
              // Delayed so clicks on the dropdown and the detail hint land first.
              onBlur={() => scheduleTimeout(() => setIsFocused(false), 150)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              aria-label={ariaLabel}
              className={cn(
                'relative block w-full resize-none bg-transparent caret-foreground outline-none',
                'min-h-[18px] max-h-[200px] text-[12px] leading-[18px]',
                'placeholder:text-text-tertiary',
                'disabled:cursor-not-allowed disabled:opacity-50',
                showTokens
                  ? 'text-transparent selection:bg-primary/20 selection:text-transparent'
                  : 'text-foreground/90'
              )}
            />

            {isPickerOpen && (
              <AutocompleteDropdown
                type="note"
                options={noteOptions}
                selectedIndex={pickerIndex}
                onSelect={selectNote}
                onClose={() => setPickerDismissed(true)}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {isFocused ? (
              onOpenDetail ? (
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openDetail}
                  className="flex items-center gap-1 text-[9px] text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  <span className="inline-flex items-center gap-0.5 rounded-[3px] border border-border bg-foreground/5 px-1 font-[family-name:var(--font-mono)] font-medium leading-3">
                    {isMac ? '⌘' : 'Ctrl'} ↵
                  </span>
                  <span>{t('capture.detailHint')}</span>
                </button>
              ) : null
            ) : (
              <span className="rounded-[3px] border border-border bg-foreground/5 px-1">
                <span className="font-[family-name:var(--font-mono)] text-[9px] font-medium leading-3 text-text-tertiary">
                  {t('capture.focusHint')}
                </span>
              </span>
            )}

            {attachment && (
              <button
                type="button"
                // The surface may disable this button as soon as the import
                // starts; firing on pointerdown keeps the activation from being
                // swallowed by the re-render that applies `disabled`.
                onPointerDown={() => {
                  attachFiredByPointerRef.current = true
                  void attachment.onAttach()
                }}
                onPointerLeave={() => {
                  attachFiredByPointerRef.current = false
                }}
                onClick={() => {
                  // Keyboard activation only — a mouse press already fired.
                  if (attachFiredByPointerRef.current) {
                    attachFiredByPointerRef.current = false
                    return
                  }
                  void attachment.onAttach()
                }}
                disabled={disabled || attachBusy}
                aria-label={attachment.label}
                title={attachment.title ?? attachment.label}
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground/50 transition-colors duration-200 hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-30"
              >
                {attachBusy ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Paperclip className="size-3" aria-hidden="true" />
                )}
              </button>
            )}

            {voice && (
              <button
                type="button"
                onClick={() => void handleMicClick()}
                disabled={disabled}
                aria-label={voice.label}
                title={voice.title ?? voice.label}
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground/50 transition-[color,opacity,transform] duration-150 ease-out hover:text-muted-foreground active:scale-90 disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100"
              >
                <Mic className="size-3" aria-hidden="true" />
              </button>
            )}

            {trailing}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!trimmed || disabled}
              aria-label={submitLabel?.(value) ?? t('capture.submit')}
              className={cn(
                'flex size-5 items-center justify-center rounded-md transition-colors duration-200',
                'disabled:cursor-not-allowed',
                !trimmed || disabled
                  ? 'text-muted-foreground/30'
                  : 'text-background dark:text-black'
              )}
              style={trimmed && !disabled ? { backgroundColor: accentColor } : undefined}
            >
              {disabled ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="size-3" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {isRecorderMounted && voice && (
          <div
            data-testid="capture-bar-recorder"
            aria-hidden={!isRecording}
            className={cn(
              'flex min-w-0 shrink-0 items-center overflow-hidden',
              'transition-[width,opacity,transform,padding] duration-300 ease-out',
              'motion-reduce:transition-none',
              isRecording
                ? 'w-[40%] translate-x-0 ps-1.5 opacity-100'
                : 'pointer-events-none w-0 translate-x-2 ps-0 opacity-0'
            )}
          >
            <VoiceRecorder
              ref={recorderRef}
              onRecordingComplete={(...args) => void handleRecordingComplete(...args)}
              onCancel={hideRecorder}
              maxDuration={voice.maxDuration ?? 300}
              className="h-full w-full"
            />
          </div>
        )}
      </div>

      {footer}
    </div>
  )
}

export default CaptureBar
