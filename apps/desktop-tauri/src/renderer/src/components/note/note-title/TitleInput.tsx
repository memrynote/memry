import {
  type FocusEvent,
  type KeyboardEvent,
  useRef,
  useEffect,
  useCallback,
  useId,
  useState,
  type RefObject
} from 'react'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface TitleInputProps {
  value: string
  placeholder?: string
  onChange: (value: string) => void | Promise<void>
  autoFocus?: boolean
  disabled?: boolean
  /** Optional external ref to the underlying textarea (e.g. to focus from a menu) */
  inputRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * A just-created note: show the field empty (the placeholder names it) until
   * the first blur, then `onFreshEnd`. Blurring with nothing typed keeps `value`.
   */
  fresh?: boolean
  onFreshEnd?: () => void
}

export function TitleInput({
  value,
  placeholder,
  onChange,
  autoFocus = false,
  disabled = false,
  inputRef,
  fresh = false,
  onFreshEnd
}: TitleInputProps) {
  const { t } = useT('notes')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const displayValue = draftValue ?? (fresh ? '' : value)

  // Merge the internal auto-resize ref with an optional external ref.
  const setTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      if (inputRef) inputRef.current = node
    },
    [inputRef]
  )

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }, [])

  useEffect(() => {
    adjustHeight()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- effect re-runs on this trigger by design; the value is not read in the effect
  }, [displayValue, adjustHeight])

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
      // Place cursor at end
      const length = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(length, length)
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftValue(e.target.value)
    // Don't call onChange on every keystroke - only update local state
    // The actual save happens on blur
  }, [])

  // A draft outlives a window deactivation (see `handleBlur`), so it is still unsaved when the
  // app quits, the tab closes or another note replaces this one. A flush (the quit's, or an
  // agent's edit proposal's) saves it and leaves the edit going; the unmount ends it.
  const pendingDraft = useRef<{ flush: () => void | Promise<void>; commit: () => void } | null>(
    null
  )
  // The draft a flush saved, which the commit ending the edit does not rename to again.
  const flushedDraft = useRef<string | null>(null)

  const commit = useCallback((): void => {
    pendingDraft.current = null
    const draft = draftValue === flushedDraft.current ? null : draftValue
    flushedDraft.current = null
    // Only trigger onChange if value actually changed
    if (fresh) {
      if (draft?.trim()) void onChange(draft)
      onFreshEnd?.()
    } else if (draft !== null && draft !== value) {
      void onChange(draft)
    }
    setDraftValue(null)
  }, [draftValue, value, onChange, fresh, onFreshEnd])

  const flush = useCallback((): void | Promise<void> => {
    if (draftValue === null || draftValue === flushedDraft.current) return undefined
    if (fresh ? !draftValue.trim() : draftValue === value) return undefined
    flushedDraft.current = draftValue
    return onChange(draftValue)
  }, [draftValue, value, fresh, onChange])

  useEffect(() => {
    pendingDraft.current = draftValue === null ? null : { flush, commit }
  }, [draftValue, flush, commit])
  const saveKey = `note-title:${useId()}`
  useEffect(() => {
    registerPendingSave(saveKey, () => pendingDraft.current?.flush())
    return () => {
      pendingDraft.current?.commit()
      unregisterPendingSave(saveKey)
    }
  }, [saveKey])

  // Enter commits before it blurs, as the blur of a window without focus is ignored below.
  const committedByEnter = useRef(false)

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLTextAreaElement>) => {
      if (committedByEnter.current) return
      // Switching to another window is not leaving the field. Chromium (WebView2 on
      // Windows) blurs the focused field, with nothing to focus next, when the window is
      // deactivated and focuses it again on return; WebKit (macOS, Linux) fires no
      // `focusout` there.
      if (e.relatedTarget === null && !e.currentTarget.ownerDocument.hasFocus()) return
      commit()
    },
    [commit]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter saves and blurs
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commit()
        committedByEnter.current = true
        textareaRef.current?.blur()
        committedByEnter.current = false
      }
      // Escape reverts and blurs
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraftValue(null)
        textareaRef.current?.blur()
      }
    },
    [commit]
  )

  return (
    <textarea
      ref={setTextareaRef}
      value={displayValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      placeholder={placeholder ?? t('editor.title.untitled')}
      disabled={disabled}
      rows={1}
      aria-label={t('editor.title.aria')}
      className={cn(
        'w-full resize-none overflow-hidden bg-transparent',
        'text-[42px] tracking-[-0.02em] leading-12 text-text-bright',
        'placeholder:text-text-tertiary placeholder:font-normal',
        'border-none outline-none',
        'focus:outline-none',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
      style={{
        fontFamily: 'var(--font-sans)'
      }}
    />
  )
}
