/**
 * The TypeScript reference port of `extract_blocks` (N102).
 *
 * The sibling of `extract-text.ts`: that one is the reference for the core's
 * only *text* operation, this one is the reference for the richer walk a shell
 * renders from. `crates/memry-core/src/crdt/blocks.rs` is the other port, and
 * `note-blocks.json` is what holds the two together.
 *
 * **Not markdown, and not a rendering.** It reports node names, attributes and
 * inline runs verbatim. A shell decides that `numberedListItem` draws `3.`;
 * the walk never says so.
 *
 * **Nothing is dropped for being unknown** (FR-033). A block type this build
 * has never heard of crosses with its own tag as `kind`, its attributes as
 * `props` and its text as inline runs. The same goes for an unknown inline
 * element and an unknown mark.
 */
import * as Y from 'yjs'

/** One attribute of a block, as the document spells it. */
export interface BlockProp {
  name: string
  value: string
}

/** A run of inline content sharing one set of marks. */
export interface InlineRun {
  text: string
  marks: string[]
  /** See `InlineRun::mark_attrs` in the Rust port; the rules are identical. */
  markAttrs: Record<string, string>
  target: string | null
}

/** One block of a note body. */
export interface Block {
  id: string | null
  kind: string
  depth: number
  props: BlockProp[]
  inline: InlineRun[]
}

/**
 * Structural nodes carrying no block of their own.
 *
 * `table` and `tableRow` are deliberately **not** here, and `extract-text.ts`'s
 * list deliberately differs: treating them as containers put every cell of
 * every row at one depth with no row boundary, and stuck the table's own
 * `blockContainer` id on its first cell.
 */
const CONTAINERS = new Set(['blockContainer', 'blockGroup'])

/** Node names that are inline content rather than blocks. */
const INLINE_NODES = new Set([
  'wikiLink',
  'hashTag',
  'dateMention',
  'linkMention',
  'inlineImage',
  'inlineCheckbox'
])

/** The attribute BlockNote stores a string-valued style's value under. */
const STRING_VALUE_ATTR = 'stringValue'

/**
 * A value as `yrs`'s `Any::Display` renders it, which is what the Rust port's
 * `props_of` records.
 *
 * Not JSON: a string is raw and unquoted, an array is `[a, b]` with a comma
 * and a space, a map is `{k: v}`. Reproduced here rather than improved on,
 * because the two ports must agree and the Rust side is pinned by the vectors.
 */
function anyDisplay(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return numberDisplay(value)
  if (Array.isArray(value)) return `[${value.map(anyDisplay).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, inner]) => `${key}: ${anyDisplay(inner)}`
    )
    return `{${entries.join(', ')}}`
  }
  return String(value)
}

/** Rust prints a whole `f64` without a fractional part, and so does JS. */
function numberDisplay(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : Number.isNaN(value) ? 'NaN' : '-inf'
  return String(value)
}

/**
 * One value as `scalar` renders it in the Rust port: a string raw, a structure
 * as JSON, everything else as its display form.
 */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return canonicalJson(value)
  return anyDisplay(value)
}

/** `serde_json`'s output for a map or an array, with map keys in insertion order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * y-prosemirror keys a mark that does not exclude itself as
 * `name--<8 character hash>`, and strips the suffix again when reading.
 */
function markName(attribute: string): string {
  const match = /^(.+)--([A-Za-z0-9+/=]{8})$/.exec(attribute)
  return match ? match[1] : attribute
}

/** One mark's attribute value, flattened. See the Rust port's `flatten_mark_attrs`. */
function flattenMarkAttrs(mark: string, value: unknown, out: Record<string, string>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return
    if (entries.length === 1 && entries[0][0] === STRING_VALUE_ATTR) {
      out[mark] = scalar(entries[0][1])
      return
    }
    for (const [key, inner] of entries) {
      // ProseMirror spells "this attribute is not set" as null, and a link's
      // unused `target` and `rel` arrive that way on every link.
      if (inner === null || inner === undefined) continue
      out[`${mark}.${key}`] = scalar(inner)
    }
    return
  }
  out[mark] = scalar(value)
}

/** A link mark's address, which is an attribute rather than the mark's value. */
function linkTarget(marks: string[], attrs: Record<string, string>): string | null {
  for (const mark of marks) {
    if (mark !== 'link' && mark !== 'href') continue
    const value = attrs[`${mark}.href`] ?? attrs[mark]
    if (value !== undefined) return value
  }
  return null
}

function attribute(element: Y.XmlElement, name: string): string | null {
  const value = element.getAttribute(name) as unknown
  return value === undefined || value === null ? null : anyDisplay(value)
}

function propsOf(element: Y.XmlElement): BlockProp[] {
  return Object.entries(element.getAttributes() as Record<string, unknown>)
    .map(([name, value]) => ({ name, value: anyDisplay(value) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** One `XmlText`'s deltas, as runs. */
function runsOfText(text: Y.XmlText): InlineRun[] {
  const runs: InlineRun[] = []
  for (const chunk of text.toDelta() as Array<{
    insert: unknown
    attributes?: Record<string, unknown>
  }>) {
    if (typeof chunk.insert !== 'string') continue
    const marks: string[] = []
    const markAttrs: Record<string, string> = {}
    const entries = Object.entries(chunk.attributes ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
    for (const [key, value] of entries) {
      const mark = markName(key)
      flattenMarkAttrs(mark, value, markAttrs)
      if (!marks.includes(mark)) marks.push(mark)
    }
    runs.push({ text: chunk.insert, marks, markAttrs, target: linkTarget(marks, markAttrs) })
  }
  return runs
}

/** Where an inline node points, by the attribute its own type uses. */
function inlineTarget(element: Y.XmlElement): string | null {
  for (const name of ['target', 'href', 'url', 'tag', 'date', 'src', 'noteId']) {
    const value = attribute(element, name)
    if (value !== null) return value
  }
  return null
}

/** An inline node's attributes, keyed `tag.attribute`. */
function nodeAttrs(element: Y.XmlElement, tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(element.getAttributes() as Record<string, unknown>)) {
    out[`${tag}.${name}`] = anyDisplay(value)
  }
  return out
}

function merge(inherited: string[], own: string[]): string[] {
  const marks = [...inherited]
  for (const mark of own) if (!marks.includes(mark)) marks.push(mark)
  return marks
}

function collectRuns(element: Y.XmlElement, inherited: string[], runs: InlineRun[]): void {
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const run of runsOfText(child)) {
        run.marks = merge(inherited, run.marks)
        if (run.text.length > 0) runs.push(run)
      }
      continue
    }
    if (!(child instanceof Y.XmlElement)) continue
    const name = child.nodeName
    // A nested block contributes its own entry, not this block's text.
    if (!INLINE_NODES.has(name)) continue

    const marks = [...inherited, name]
    const attrs = nodeAttrs(child, name)
    const target = inlineTarget(child)
    const before = runs.length
    collectRuns(child, marks, runs)
    for (const run of runs.slice(before)) {
      if (run.target === null) run.target = target
      for (const [key, value] of Object.entries(attrs)) {
        if (!(key in run.markAttrs)) run.markAttrs[key] = value
      }
    }
    // An inline node with no text of its own is still a run, or the shell
    // never hears about it.
    if (runs.length === before) runs.push({ text: '', marks, markAttrs: attrs, target })
  }
}

function inlineRuns(element: Y.XmlElement): InlineRun[] {
  const runs: InlineRun[] = []
  collectRuns(element, [], runs)
  return runs
}

function walkElement(element: Y.XmlElement, depth: number, blocks: Block[], atRoot: boolean): void {
  const name = element.nodeName

  if (CONTAINERS.has(name)) {
    // A `blockContainer` holds one block plus, sometimes, a `blockGroup` of
    // children; only the group is a level deeper — except the one the fragment
    // always carries (§12.5.0), which is structure rather than nesting.
    const deeper = name === 'blockGroup' && !atRoot ? depth + 1 : depth
    const containerId = attribute(element, 'id')
    const before = blocks.length
    walk(element, deeper, blocks, false)
    const first = blocks[before]
    if (containerId !== null && first !== undefined && first.id === null) first.id = containerId
    return
  }

  blocks.push({
    id: null,
    kind: name,
    depth,
    props: propsOf(element),
    inline: inlineRuns(element)
  })

  // A block may nest further blocks. They are their own entries, one level
  // deeper, after this one.
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement && !INLINE_NODES.has(child.nodeName)) {
      walkElement(child, depth + 1, blocks, false)
    }
  }
}

/**
 * `atRoot` marks the fragment's own children. See the Rust port: the single
 * top-level `blockGroup` §12.5.0 mandates is structural, not nesting.
 */
function walk(
  node: Y.XmlFragment | Y.XmlElement,
  depth: number,
  blocks: Block[],
  atRoot: boolean
): void {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement) {
      walkElement(child, depth, blocks, atRoot)
      continue
    }
    if (child instanceof Y.XmlText) {
      // Loose text directly under the fragment has no block of its own.
      // `extract_text` emits it as a line, so it becomes a paragraph here
      // rather than disappearing.
      const runs = runsOfText(child)
      if (runs.some((run) => run.text.length > 0)) {
        blocks.push({ id: null, kind: 'paragraph', depth, props: [], inline: runs })
      }
    }
  }
}

/**
 * The body as blocks.
 *
 * An empty document is an empty list, never a single empty paragraph: a note
 * nobody has written is not a note with one blank line in it.
 */
export function extractBlocks(doc: Y.Doc): Block[] {
  const blocks: Block[] = []
  walk(doc.getXmlFragment('prosemirror'), 0, blocks, true)
  return blocks
}
