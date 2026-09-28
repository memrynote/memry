/**
 * A checkbox that stays a checkbox.
 *
 * A note's `- [ ] Buy milk` line becomes a task as soon as the editor sees it
 * (see `task-block.ts`), which is what most checkboxes are for. Some are not: a
 * packing list, a checklist inside a meeting note. Those are marked "plain",
 * and a plain checkbox is never converted.
 *
 * In the editor the mark is the `checkListItem` block's `plain` prop. In the
 * vault file it is a trailing marker on the line:
 *
 *     - [ ] Passport {check}
 *
 * The same end-of-line slot `{task:<id>}` uses, so the file keeps saying what
 * the line is when the document is rebuilt from it (an edit made outside the
 * app, a fresh device). An older Memry ignores the prop in a synced document and
 * reads the marker as text in a file; either way it converts the line, as it
 * did every checkbox. Nothing is lost, the line just becomes a task.
 *
 * Pure and dependency-free: the renderer and the main process both call this,
 * on the way in (`normalizePlainCheckboxes`, after markdown is parsed) and on
 * the way out (`withPlainCheckboxMarkers`, before blocks are serialized), so
 * the two can never write the marker differently.
 */

export const PLAIN_CHECKBOX_MARKER = '{check}'

interface PlainCheckboxInline {
  type?: string
  text?: string
  styles?: Record<string, unknown>
}

export interface PlainCheckboxBlock {
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: PlainCheckboxBlock[]
}

function isPlainText(item: unknown): item is PlainCheckboxInline & { text: string } {
  if (!item || typeof item !== 'object') return false
  const inline = item as PlainCheckboxInline
  return inline.type === 'text' && typeof inline.text === 'string'
}

/**
 * The block's inline content without a trailing marker, or null when the last
 * run does not end with one. Only the last run is read: the marker is written
 * as its own unstyled run, and a marker the user typed inside bold or a link is
 * their text, not ours.
 */
function stripMarker(content: unknown): unknown[] | null {
  if (!Array.isArray(content) || content.length === 0) return null
  const last = content[content.length - 1]
  if (!isPlainText(last)) return null
  const trimmed = last.text.trimEnd()
  if (!trimmed.endsWith(PLAIN_CHECKBOX_MARKER)) return null

  const before = trimmed.slice(0, -PLAIN_CHECKBOX_MARKER.length).trimEnd()
  const head = content.slice(0, -1)
  return before ? [...head, { ...last, text: before }] : head
}

/** True when a plain checkbox's line text ends with the marker. */
export function hasPlainCheckboxMarker(text: string): boolean {
  return text.trimEnd().endsWith(PLAIN_CHECKBOX_MARKER)
}

/**
 * Parse side: every `checkListItem` whose line ends with the marker loses the
 * marker from its text and gains `plain: true`. Walks every depth.
 */
export function normalizePlainCheckboxes<T extends PlainCheckboxBlock>(
  blocks: T[]
): { blocks: T[]; didChange: boolean } {
  let didChange = false

  const walk = (list: T[]): T[] => {
    let listChanged = false
    const next = list.map((block) => {
      let out = block
      if (block.type === 'checkListItem') {
        const content = stripMarker(block.content)
        if (content) {
          out = { ...out, content, props: { ...block.props, plain: true } }
        }
      }
      if (block.children?.length) {
        const children = walk(block.children as T[])
        if (children !== block.children) out = { ...out, children }
      }
      if (out !== block) listChanged = true
      return out
    })
    if (!listChanged) return list
    didChange = true
    return next
  }

  const next = walk(blocks)
  return { blocks: didChange ? next : blocks, didChange }
}

/**
 * Serialize side: a copy of `blocks` where every plain `checkListItem` carries
 * the marker as a last, unstyled run, so the line is written
 * `- [ ] Passport {check}`. Blocks without one come back as they were.
 */
export function withPlainCheckboxMarkers<T extends PlainCheckboxBlock>(blocks: T[]): T[] {
  let changed = false
  const next = blocks.map((block) => {
    let out = block
    if (block.type === 'checkListItem' && block.props?.plain === true) {
      const content = Array.isArray(block.content) ? block.content : []
      const marker = content.length > 0 ? ` ${PLAIN_CHECKBOX_MARKER}` : PLAIN_CHECKBOX_MARKER
      out = { ...out, content: [...content, { type: 'text', text: marker, styles: {} }] }
    }
    if (block.children?.length) {
      const children = withPlainCheckboxMarkers(block.children as T[])
      if (children !== block.children) out = { ...out, children }
    }
    if (out !== block) changed = true
    return out
  })
  return changed ? next : blocks
}
