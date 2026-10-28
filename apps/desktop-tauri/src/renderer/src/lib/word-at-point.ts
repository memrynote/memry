/**
 * The word under a screen point or a field's caret, for spelling suggestions. The page asks for
 * the word itself because the system web views send no spelling data with a right-click.
 */

const HAS_LETTER = /\p{L}/u

export interface WordSpan {
  word: string
  /** UTF-16 offsets into the text the span was found in. */
  start: number
  end: number
}

/** The word of `text` that `offset` falls in or touches; null on whitespace, punctuation or digits. */
export function wordSpanAtOffset(text: string, offset: number): WordSpan | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  for (const segment of segmenter.segment(text)) {
    const start = segment.index
    const end = start + segment.segment.length
    if (offset < start) break
    if (offset > end) continue
    // A caret just after a word (`word|`) still belongs to it.
    if (segment.isWordLike && HAS_LETTER.test(segment.segment)) {
      return { word: segment.segment, start, end }
    }
  }
  return null
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y)
    if (position) return { node: position.offsetNode, offset: position.offset }
  }
  // WebKit has only the older range form.
  // oxlint-disable-next-line typescript/no-deprecated -- the only form WebKit ships before `caretPositionFromPoint`
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** The word of the page text under `(x, y)` and a range over it; null when not on a word. */
export function wordAtPoint(x: number, y: number): (WordSpan & { range: Range }) | null {
  const caret = caretAt(x, y)
  if (caret?.node.nodeType !== Node.TEXT_NODE) return null
  const span = wordSpanAtOffset(caret.node.textContent ?? '', caret.offset)
  if (!span) return null
  const range = document.createRange()
  range.setStart(caret.node, span.start)
  range.setEnd(caret.node, span.end)
  return { ...span, range }
}

/**
 * The word at the caret of a text field, whose text the caret APIs above do not reach. WebKitGTK
 * moves the caret to the pointer on a right-click, so the caret is where the pointer is, except
 * inside an existing selection, which the click keeps. Then the answer is the selection only when
 * it is exactly one word; any other selection starts somewhere the pointer may not be.
 */
export function wordAtCaret(field: HTMLInputElement | HTMLTextAreaElement): WordSpan | null {
  const { selectionStart: start, selectionEnd: end } = field
  if (start === null) return null
  const span = wordSpanAtOffset(field.value, start)
  if (start === end) return span
  return span?.start === start && span.end === end ? span : null
}
