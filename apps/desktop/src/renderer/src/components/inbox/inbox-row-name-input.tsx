import { useCallback, useRef, useState } from 'react'

export interface InboxRowNameInputProps {
  /** Title the row started with — also what Escape and a blank entry revert to */
  initialValue: string
  /** Accessible name for the field */
  ariaLabel: string
  /** Called with the trimmed title when the edit commits with a real change */
  onSubmit: (value: string) => void
  /** Called when the edit ends without a change */
  onCancel: () => void
}

/**
 * Inline rename field for an inbox row. Mirrors the sidebar canvas row input's
 * proven sequence (focus+select a frame late, Enter commits, Escape reverts,
 * blur commits, keydown stops propagating so row shortcuts stay quiet), minus
 * the canvas-specific busy/error states — inbox titles have no uniqueness
 * constraint, so a rename cannot be refused.
 */
export function InboxRowNameInput({
  initialValue,
  ariaLabel,
  onSubmit,
  onCancel
}: InboxRowNameInputProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  // Blur fires again as Enter/Escape move focus away; without this the commit
  // would run twice and a reverted edit would come back as a save.
  const settledRef = useRef(false)

  const attach = useCallback((element: HTMLInputElement | null) => {
    if (!element) return
    requestAnimationFrame(() => {
      // jsdom does not implement scrollIntoView; guard so tests still exercise
      // the focus/select half of the sequence.
      element.scrollIntoView?.({ block: 'nearest' })
      element.focus()
      element.select()
    })
  }, [])

  const settle = useCallback(
    (next: string): void => {
      if (settledRef.current) return
      settledRef.current = true
      const trimmed = next.trim()
      if (!trimmed || trimmed === initialValue) {
        onCancel()
        return
      }
      onSubmit(trimmed)
    },
    [initialValue, onCancel, onSubmit]
  )

  return (
    <input
      ref={attach}
      type="text"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          settle(value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          settledRef.current = true
          onCancel()
        }
        // The row's Delete/Backspace shortcuts must not fire from inside a text
        // field. React synthetic events bubble to the row, so stopping here is
        // what makes typing a plain edit.
        event.stopPropagation()
      }}
      onBlur={() => settle(value)}
      // The row opens the detail panel on click; placing the caret is not that.
      onClick={(event) => event.stopPropagation()}
      className="h-5 w-full min-w-0 rounded border border-input bg-background px-1 text-[13px] focus:outline-none"
    />
  )
}

export default InboxRowNameInput
