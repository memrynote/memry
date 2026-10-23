import { useEffect, useRef } from 'react'

export interface InboxTitleInputProps {
  /** Item id — remounts the uncontrolled input when the panel switches items */
  itemId: string
  /** Current persisted title */
  title: string
  /** Placeholder and accessible name */
  placeholder: string
  /** Called with the new title once the edit commits */
  onSave: (title: string) => void
}

/**
 * Editable title for inbox items whose title is a real, user-owned field
 * (voice, image, pdf). Uncontrolled so typing never fights the query cache:
 * Enter commits, Escape reverts, blur commits, and a blank entry snaps back to
 * the previous title instead of persisting an empty name.
 */
export function InboxTitleInput({
  itemId,
  title,
  placeholder,
  onSave
}: InboxTitleInputProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  // Background jobs rename items behind our back (voice transcription, link
  // metadata). Adopt that new title, but only while the user isn't typing.
  useEffect(() => {
    const input = inputRef.current
    if (!input || document.activeElement === input) return
    input.value = title
  }, [title])

  const commit = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) {
      if (inputRef.current) inputRef.current.value = title
      return
    }
    onSave(trimmed)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      key={itemId}
      defaultValue={title}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
          return
        }
        if (e.key === 'Escape') {
          e.currentTarget.value = title
          e.currentTarget.blur()
        }
      }}
      className="text-[15px] leading-5 font-medium text-foreground mb-3.5 w-full bg-transparent focus:outline-none border-b border-transparent focus:border-muted-foreground/20 transition-colors"
      placeholder={placeholder}
      aria-label={placeholder}
    />
  )
}

export default InboxTitleInput
