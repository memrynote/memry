/**
 * Marquee hit-testing — one home for "what did this press land on?".
 *
 * Two call sites ask a location question about a mousedown in the editor:
 *
 *   - the marquee selection hook: "may this press start a marquee at all?"
 *     (`shouldStartMarquee`)
 *   - the note page's and the journal page's click-to-focus-end handlers:
 *     "is this press outside every block?" (`isOutsideAllBlocks`)
 *
 * They used to answer those questions with inline copies scattered across the
 * hook and both pages, where two of the copies were byte-identical and the
 * third was a different rule entirely. Co-locating them is the point: they are
 * deliberately NOT the same test, and the only way that stays deliberate rather
 * than accidental is for a change to one to sit next to the other.
 *
 * #1444 adds a third question here — "is there selectable text at this press?",
 * the gate that stops a marquee starting from inside a line of text. Read
 * `isOutsideAllBlocks` below before assuming it can answer that one too.
 *
 * This module is pure DOM inspection — no editor, no React, no state. Every
 * function takes the raw `event.target` and answers from ancestry alone.
 */

/** BlockNote's block content element: the box a single block's content lives in. */
const BLOCK_CONTENT_SELECTOR = '.bn-block-content'

/**
 * Is this press outside every block — i.e. in the margin, the gutter, or the
 * empty space below the last block?
 *
 * This is what the note page's and journal page's click-to-focus-end handlers
 * ask before calling `preventDefault()` + `focusAtEnd()`. It is the exact
 * negation of the composite condition those handlers carried inline, moved
 * here unchanged: a press counts as "inside a block" only when it is inside a
 * contenteditable subtree AND inside a block content box.
 *
 * Do not "simplify" this to a lone `.bn-block-content` lookup. The two halves
 * are not equivalent: ProseMirror sets `contenteditable="false"` on its root
 * when the editor is not editable, so a read-only surface renders
 * `.bn-block-content` with no `contenteditable="true"` ancestor and the
 * composite still classifies those presses as "outside".
 *
 * The `contains()` call is, under standard DOM semantics, always true when
 * `closest()` returned non-null — `closest` walks up from the target itself.
 * It is kept byte-for-byte anyway, because this module landed as a pure
 * prefactor with a zero-behaviour-change promise; dropping it is a separate,
 * deliberate decision, not a drive-by tidy.
 *
 * ## Why the marquee start rule (#1444) cannot reuse this
 *
 * "Outside every block" and "no selectable text here" sound like the same
 * question and have different answers. A task block sits inside
 * `.bn-block-content` but holds no editable text at all, so answering the
 * marquee question with this predicate would classify a press on a task row as
 * "inside a block" and refuse to start a marquee there — and answering THIS
 * question with the marquee's predicate would classify a click on a task row
 * as "outside every block", firing `preventDefault()` + `focusAtEnd()` on it,
 * jumping the caret to the end of the document and suppressing the row's own
 * focus handling so the task title could no longer be opened for inline
 * editing. The two stay separate on purpose.
 *
 * Note this predicate carries no interactive-element exclusions. The callers
 * keep their own menu / toolbar / form-control exclusion lists, which are
 * wider than `shouldStartMarquee`'s (they also exclude `.bn-menu-dropdown` and
 * `[role="menu"]`, because BlockNote's nested submenus render inside the
 * marquee zone rather than being portaled out of it).
 */
export function isOutsideAllBlocks(target: Element): boolean {
  const insideBlock =
    target.closest('[contenteditable="true"]')?.contains(target) === true &&
    target.closest(BLOCK_CONTENT_SELECTOR) !== null
  return !insideBlock
}

/**
 * May a press on this element begin a marquee drag at all?
 *
 * The interactive-element exclusion list: buttons, links, form controls,
 * anything opted out with `data-marquee-ignore`, and BlockNote's own menus and
 * toolbars. Moved verbatim out of `use-block-marquee-selection.ts`.
 *
 * A consequence worth stating rather than rediscovering: a bookmark card's
 * whole surface is a link, so a marquee can never start from a bookmark's own
 * body. Clicking it should open the link; selecting it is reached from the
 * margin instead.
 */
export function shouldStartMarquee(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-marquee-ignore]')) return false
  if (target.closest('button, a, input, textarea, select, [role="button"]')) return false
  if (
    target.closest(
      '.bn-side-menu, .bn-formatting-toolbar, .bn-suggestion-menu, .bn-link-toolbar, .bn-drag-handle-menu'
    )
  ) {
    return false
  }
  return true
}
