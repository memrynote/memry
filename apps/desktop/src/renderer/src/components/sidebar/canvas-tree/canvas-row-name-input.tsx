/**
 * The text field a canvas tree row turns into while it is being named.
 *
 * Renaming and naming a freshly created row both happen HERE, on the row, the
 * way the notes tree does it — never in a dialog. A modal for a two-word edit
 * takes the row out from under the user, and after it closes they have to find
 * the row again.
 *
 * Shared by both row kinds because the semantics have to match exactly: Enter
 * commits, Escape abandons, and BLUR commits — clicking away is an accepted
 * name, not a lost one. With one exception, in `onBlur` below: on a name the
 * store has just refused, blur is the way OUT instead.
 *
 * @module components/sidebar/canvas-tree/canvas-row-name-input
 */

import * as React from 'react'

/**
 * Everything a row needs to draw the field. Present only for the ONE row being
 * named — its absence is what tells the row to render its label instead.
 */
export interface CanvasRowEdit {
  value: string
  /** True while the mutation is in flight. The field goes inert, never away. */
  busy: boolean
  /**
   * Why the last attempt was refused, already translated, or `null`.
   *
   * A name the store rejects (a collision, the depth cap, an illegal character)
   * has to leave the user in the field with the reason — reverting silently
   * would read as the app ignoring them.
   *
   * Set only while the field still holds the exact value that earned it: the
   * message and the string it is about travel together, so an error on screen
   * always means "the name currently typed here is the refused one". Both the
   * blur rule and the refocus below depend on reading it that way.
   */
  error: string | null
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

export interface CanvasRowNameInputProps {
  edit: CanvasRowEdit
  /** Accessible name. The field has no visible label, so this is the only one. */
  ariaLabel: string
}

export function CanvasRowNameInput({
  edit,
  ariaLabel
}: CanvasRowNameInputProps): React.JSX.Element {
  const errorId = React.useId()
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  /**
   * Focuses and SELECTS on mount, so the first keystroke replaces the old name
   * instead of appending to it — and scrolls the row into view first, because a
   * row created inside a folder further down the list is otherwise a field the
   * user is typing into blind.
   *
   * Deferred a frame the way the notes tree defers it: the row is still
   * committing, and a menu closing in the same tick would otherwise restore
   * focus over the top of this.
   */
  const attach = React.useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element
    if (!element) return
    requestAnimationFrame(() => {
      // jsdom does not implement it; a guard keeps the tests honest about the
      // rest of the sequence rather than throwing before `select`.
      element.scrollIntoView?.({ block: 'nearest' })
      element.focus()
      element.select()
    })
  }, [])

  // Blur is a commit, so a name refused after the user clicked away would strand
  // the reason on a field nobody is in. Pull them back to fix it.
  React.useEffect(() => {
    if (edit.error) inputRef.current?.focus()
  }, [edit.error])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <input
        ref={attach}
        type="text"
        aria-label={ariaLabel}
        aria-invalid={edit.error ? true : undefined}
        aria-describedby={edit.error ? errorId : undefined}
        value={edit.value}
        disabled={edit.busy}
        onChange={(event) => edit.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            edit.onSubmit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            edit.onCancel()
          }
          // The row's own F2 and Delete shortcuts must not fire from inside a
          // text field. React synthetic events bubble to the row, so stopping
          // here is what makes typing a plain edit.
          event.stopPropagation()
        }}
        /*
          Blur commits — unless the reason on screen belongs to the name
          currently in the field. Committing that again fails again, and the
          effect above then takes focus back: together they made a refused name
          a trap, one the user could only leave by getting the name right or by
          knowing about Escape, having fired a doomed write on every attempt.

          So blur is the SECOND way out. Of the honest options — never
          committing from a blur, never refocusing after a failure, refocusing
          only after an explicit Enter — this is the one that keeps both halves
          where they earn their keep: clicking away from a fresh name still
          accepts it, and a refusal still pulls the user back once, with the
          reason, rather than stranding the message on a field nobody is in.

          Nothing is lost quietly. The only value blur abandons is one the app
          has just said, inline and in a toast, that it cannot use, and any edit
          the user makes clears that message and makes blur a commit again.
        */
        onBlur={() => {
          if (edit.error) {
            edit.onCancel()
            return
          }
          edit.onSubmit()
        }}
        // The row opens the canvas or toggles the folder on click; putting the
        // caret somewhere is neither.
        onClick={(event) => event.stopPropagation()}
        className="h-5 w-full rounded border border-input bg-background px-1 text-[13px] focus:outline-none"
      />
      {edit.error && (
        <span id={errorId} role="alert" className="mt-0.5 text-[10px] leading-3 text-destructive">
          {edit.error}
        </span>
      )}
    </div>
  )
}

export default CanvasRowNameInput
