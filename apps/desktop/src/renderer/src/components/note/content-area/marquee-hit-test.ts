/**
 * Marquee hit-testing — one home for "what did this press land on?".
 *
 * Three call sites ask a location question about a mousedown in the editor:
 *
 *   - the marquee selection hook: "may this press start a marquee at all?"
 *     (`shouldStartMarquee`)
 *   - the same hook, once that is settled: "is there selectable text at this
 *     press?" (`hasSelectableTextAt`) — the gate that stops a marquee starting
 *     from inside a line of text
 *   - the note page's and the journal page's click-to-focus-end handlers:
 *     "is this press outside every block?" (`isOutsideAllBlocks`)
 *
 * They used to answer those questions with inline copies scattered across the
 * hook and both pages, where two of the copies were byte-identical and the
 * third was a different rule entirely. Co-locating them is the point: they are
 * deliberately NOT the same test, and the only way that stays deliberate rather
 * than accidental is for a change to one to sit next to the other. The last two
 * in particular sound like one question and answer differently on a task block.
 *
 * This module is pure DOM inspection — no editor, no React, no state. Every
 * function takes the raw `event.target` and answers from ancestry alone.
 */

/** BlockNote's block content element: the box a single block's content lives in. */
const BLOCK_CONTENT_SELECTOR = '.bn-block-content'

/** BlockNote's inline content element: the run of editable text inside a block. */
const INLINE_CONTENT_SELECTOR = '.bn-inline-content'

/**
 * A table cell. BlockNote renders one as a bare `<td><p>text</p></td>` — that
 * inner paragraph carries no class at all, so cells need naming in their own
 * right rather than being reached through `.bn-inline-content`.
 */
const TABLE_CELL_SELECTOR = 'td, th'

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
 * `hasSelectableTextAt` below is the marquee's question, and it is a separate
 * function for a reason: "outside every block" and "no selectable text here"
 * sound like the same question and have different answers. A task block sits
 * inside `.bn-block-content` but holds no editable text at all, so answering
 * the marquee question with this predicate would classify a press on a task row
 * as "inside a block" and refuse to start a marquee there — and answering THIS
 * question with `hasSelectableTextAt` would classify a click on a task row as
 * "outside every block", firing `preventDefault()` + `focusAtEnd()` on it,
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
export function shouldStartMarquee(target: EventTarget | null): target is HTMLElement {
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

/**
 * Is there selectable text at this press?
 *
 * The marquee start rule (#1444): a press that lands on text begins a text
 * selection and never a marquee, however far the following drag travels and in
 * whatever direction. A marquee begins only outside text — the gray margin, the
 * list-marker strip, the strip left of an indented block, a block holding no
 * editable text, or the empty area below the last block. Deciding once, from the
 * press location, is the whole point: the rule this replaced decided *during*
 * the drag from its direction, so the same starting point produced blocks when
 * the user dragged straight down and text when they drifted right.
 *
 * ## Why `.bn-inline-content` and not `contenteditable`
 *
 * "Is the press inside a `contenteditable="true"` subtree" is the obvious test
 * and the wrong one here. `base.css` sets `padding-inline: 0px` on `.bn-editor`
 * globally, so the contenteditable root spans the entire text column rather
 * than sitting inside it. Anchored there, the list-marker strip, the
 * nested-block indent strip and every non-editable custom block (task, file,
 * bookmark, YouTube embed) all sit inside the contenteditable root and would
 * report "text" — which is every marquee entry point except the outer margin.
 *
 * ## Why list markers fall outside it
 *
 * A bullet or a number is a `::before` pseudo-element owned by
 * `.bn-block-content`, and pseudo-elements are never event targets, so a press
 * on the marker reports `.bn-block-content` itself. That element has no
 * `.bn-inline-content` ancestor, so the marker strip classifies as margin with
 * no coordinate arithmetic anywhere.
 *
 * ## Why the empty space right of a short line is still text
 *
 * `.bn-inline-content` is block-level, so for a paragraph it spans the full
 * column width regardless of how far the text itself reaches. Granularity here
 * is deliberately the block box, not the line box: reclassifying the tail of a
 * short line would mean measuring line boxes on every mousedown, and users have
 * no reliable sense of where a line ended. The practical consequence, stated so
 * it is not later filed as a bug: the only place to begin a marquee on the
 * right is the gray margin outside the column.
 *
 * ## Why table cells are asked about separately
 *
 * The tripwire below is not hypothetical — a table is the case where it already
 * bites. BlockNote renders a cell as `<td colspan="1" rowspan="1"><p>text</p></td>`,
 * and that inner `<p>` carries no `.bn-inline-content` class, unlike the one in
 * a paragraph block. So the check above answers "no text" for every press
 * inside a table, the text itself included, and a drag across cells started a
 * marquee instead of selecting cells. Because a table is a single block, that
 * marquee then selected the whole table: the cells looked selected, but
 * Backspace deleted the entire table rather than the cells' contents.
 *
 * Naming cells here hands every in-table drag to prosemirror-tables, which owns
 * cell selection. The table can still be marquee-selected as a block from the
 * margin beside it, where no `td` is under the pointer.
 *
 * TRIPWIRE, read this before upgrading BlockNote. `.bn-inline-content` is a
 * BlockNote-internal class name, not a contract. If an upgrade renames it, this
 * function silently answers "no text anywhere", every press starts a marquee,
 * and text selection in the editor dies — with no type error and no crash. The
 * hook test catches it only because its fixture spells the same class name;
 * that fixture is the tripwire, so do not "modernise" it into a helper that
 * derives the name from here.
 */
export function hasSelectableTextAt(target: Element): boolean {
  if (target.closest(INLINE_CONTENT_SELECTOR) !== null) return true
  return target.closest(TABLE_CELL_SELECTOR) !== null
}
