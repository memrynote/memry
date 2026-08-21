/**
 * Private step 1 — an editor block tree becomes a logical mind-map tree.
 *
 * Not exported outside this directory: `buildMindMap` is the only seam, so this
 * file is free to change shape as later tickets add caps.
 *
 * Two hierarchy mechanisms are merged in one pass, and they work nothing alike:
 *
 * - **Headings are flat siblings** whose nesting lives in a `level` prop, so
 *   they need a level stack.
 * - **List items, toggles and callouts are genuinely nested** as `children`, so
 *   they need recursive descent and attach to whatever block contains them.
 *
 * Where the two meet, containment wins and the level stack is scoped to it: a
 * container opens a fresh stack for what is inside it, so a heading written
 * inside a toggle nests under that toggle and takes its own contents with it,
 * rather than being hoisted out and leaving its bullets behind. Within any one
 * scope a heading still governs what follows it, container or not.
 *
 * The governing rule for what appears at all: containers branch, content does
 * not — but content is never silently invisible. A toggle really holds
 * children, so flattening it would destroy something the user wrote; a table is
 * content, so it is counted on the nearest node instead of being drawn.
 *
 * A wiki link is the one thing here that is not part of this note at all. It
 * leaves the label of whatever held it and becomes a leaf of its own, the same
 * way a hash tag leaves the label and becomes a badge — a link points at
 * another document, and that is a branch rather than a word in a sentence.
 */

import { normalizeLabel, readInline, stringProp, isRecord } from './mind-map-inline'
import type { InlineWikiLink } from './mind-map-inline'
import type {
  MindMapContentCount,
  MindMapContentKind,
  MindMapNode,
  MindMapNodeKind,
  MindMapOptions,
  MindMapSourceBlock
} from './mind-map-types'

export const MIND_MAP_ROOT_ID = 'mm-root'

const MIN_HEADING_LEVEL = 1
const MAX_HEADING_LEVEL = 6

/**
 * Block type → node kind, for everything that really holds structure.
 *
 * Every string here is a registered `config.type`: the four list kinds and
 * `toggleListItem` are BlockNote defaults, `taskBlock` and `callout` are
 * Memry's own (see `packages/editor-schema/src/blocks/configs.ts`).
 */
const NODE_KINDS = new Map<string, MindMapNodeKind>([
  ['heading', 'heading'],
  ['bulletListItem', 'bullet'],
  ['numberedListItem', 'numbered'],
  ['checkListItem', 'check'],
  ['taskBlock', 'task'],
  ['toggleListItem', 'toggle'],
  ['callout', 'callout']
])

/**
 * Block type → content kind, for everything that is content rather than
 * structure. These never become nodes; they are counted on the node above.
 *
 * `video` and `audio` join `youtubeEmbed` under `embed`: all three are a piece
 * of media the map cannot draw, and leaving them out entirely would break the
 * promise that nothing disappears silently.
 */
const CONTENT_KINDS = new Map<string, MindMapContentKind>([
  ['table', 'table'],
  ['codeBlock', 'code'],
  ['image', 'image'],
  ['quote', 'quote'],
  ['youtubeEmbed', 'embed'],
  ['video', 'embed'],
  ['audio', 'embed'],
  ['bookmark', 'bookmark'],
  ['file', 'file']
])

/** Badge order, so the same note always reads the same way. */
const CONTENT_ORDER: readonly MindMapContentKind[] = [
  'table',
  'code',
  'image',
  'quote',
  'embed',
  'bookmark',
  'file'
]

function headingLevel(props: unknown): number {
  const raw = isRecord(props) ? props.level : undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return MIN_HEADING_LEVEL
  if (raw < MIN_HEADING_LEVEL) return MIN_HEADING_LEVEL
  if (raw > MAX_HEADING_LEVEL) return MAX_HEADING_LEVEL
  return raw
}

/** A checklist item's or a task's tick. Anything but `true` reads as not done. */
function isChecked(props: unknown): boolean {
  return isRecord(props) && props.checked === true
}

/** Where a run of numbered items starts, when the user moved it off 1. */
function listStart(props: unknown): number | null {
  const raw = isRecord(props) ? props.start : undefined
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

/**
 * Turns a block tree into the logical map.
 *
 * Rules that matter, all of them observable through `buildMindMap`:
 * - The root is always the note title, never the first heading.
 * - A skipped level mints no phantom intermediate node; the heading simply
 *   nests one step deeper than its nearest shallower ancestor.
 * - A note whose first heading is a deep level attaches it straight to the
 *   root: relative depth is what matters, not the absolute number.
 * - Anything before the first heading belongs to the root.
 * - A block with nothing to show — no text and no tags — draws no box and does
 *   not join the level stack; whatever sits under it folds up to the nearest
 *   ancestor that does have something to show, rather than disappearing.
 * - A wiki link becomes a leaf under the node its block belongs to, wherever it
 *   was written: a heading, a list item, or a paragraph that is no node itself.
 *   A block whose only content was its links therefore hands them straight to
 *   its own parent, so a bullet list of links is a fan of links and not a fan
 *   of empty boxes each holding one.
 */
export function projectBlocks(
  blocks: readonly MindMapSourceBlock[],
  options: MindMapOptions
): MindMapNode {
  const root: MindMapNode = {
    id: MIND_MAP_ROOT_ID,
    blockId: null,
    label: options.rootLabel,
    kind: 'root',
    level: null,
    depth: 0,
    isDone: false,
    taskId: null,
    wikiTarget: null,
    tags: [],
    contents: [],
    detail: '',
    children: []
  }

  /** Content tallies, kept aside so a node's `contents` is written once, in order. */
  const tallies = new Map<MindMapNode, Map<MindMapContentKind, number>>()
  /**
   * Block ids should be unique, but a node id collision would mint two drawing
   * elements with one id, so the suffix keeps them apart deterministically.
   */
  const usedIds = new Map<string, number>()

  const mintId = (blockId: string): string => {
    const base = `mm-${blockId}`
    const seen = usedIds.get(base) ?? 0
    usedIds.set(base, seen + 1)
    return seen === 0 ? base : `${base}-${seen + 1}`
  }

  const tally = (node: MindMapNode, kind: MindMapContentKind): void => {
    const counts = tallies.get(node) ?? new Map<MindMapContentKind, number>()
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    tallies.set(node, counts)
  }

  /**
   * One leaf per wiki link written in a block, under whatever node that block
   * belongs to — the block's own node when it minted one, otherwise the node
   * the block itself would have hung from.
   *
   * Always a leaf: what is inside the note a link names is the graph view's
   * question, not this one's.
   *
   * `blockId` is null on purpose. A wiki link is a run of inline content and
   * not a block; and `blockId` is what a click navigates TO, so a link sharing
   * its sentence's block id would send a click on the link to the sentence.
   * What the link opens is carried in `wikiTarget` instead.
   */
  const addLinks = (
    parent: MindMapNode,
    blockId: string,
    links: readonly InlineWikiLink[]
  ): void => {
    links.forEach((link, index) => {
      parent.children.push({
        id: mintId(`${blockId}-link-${index + 1}`),
        blockId: null,
        label: link.label,
        kind: 'wikiLink',
        level: null,
        depth: parent.depth + 1,
        isDone: false,
        taskId: null,
        wikiTarget: link.target,
        tags: [],
        contents: [],
        detail: '',
        children: []
      })
    })
  }

  /**
   * One level of containment: the node holding these blocks, and the headings
   * open inside it, shallowest first. A container gets its own stack so its
   * headings cannot escape it; the top level's container is the root.
   */
  interface Scope {
    container: MindMapNode
    stack: Array<{ level: number; node: MindMapNode }>
  }

  /** Whatever a block written here belongs to: the open heading, else the container. */
  const parentIn = (scope: Scope): MindMapNode =>
    scope.stack.length > 0 ? scope.stack[scope.stack.length - 1].node : scope.container

  const visitBlocks = (siblings: readonly MindMapSourceBlock[], scope: Scope): void => {
    // Numbered items count within their own uninterrupted run, exactly as the
    // editor renders them: any other block between two of them starts a new list.
    let ordinal = 0

    for (const block of siblings) {
      const kind = NODE_KINDS.get(block.type)
      const isNumbered = kind === 'numbered'
      if (isNumbered) ordinal = ordinal === 0 ? (listStart(block.props) ?? 1) : ordinal + 1
      else ordinal = 0

      if (kind === undefined) {
        const contentKind = CONTENT_KINDS.get(block.type)
        if (contentKind !== undefined) tally(parentIn(scope), contentKind)
        // A paragraph is never a node, but a wiki link written in one is still
        // somewhere this note reaches, so it branches off the node the
        // paragraph belongs to rather than being lost with it.
        addLinks(parentIn(scope), block.id, readInline(block.content).links)
        // Paragraphs, dividers and anything unregistered contribute no node and
        // never re-parent what is inside them.
        visitBlocks(block.children ?? [], scope)
        continue
      }

      // A `taskBlock` has no inline content; its text is a prop.
      const read =
        kind === 'task'
          ? { text: stringProp(block.props, 'title') ?? '', tags: [], links: [] }
          : readInline(block.content)
      const text = normalizeLabel(read.text)

      // Nothing to show: no box, no level-stack entry, and its children fold up
      // to whatever this block's own parent was. Its links fold up with them —
      // `- [[Roadmap]]` is a branch to Roadmap, not an empty box holding one.
      if (text === '' && read.tags.length === 0) {
        addLinks(parentIn(scope), block.id, read.links)
        visitBlocks(block.children ?? [], scope)
        continue
      }

      const level = kind === 'heading' ? headingLevel(block.props) : null
      if (level !== null) {
        while (scope.stack.length > 0 && scope.stack[scope.stack.length - 1].level >= level) {
          scope.stack.pop()
        }
      }
      const parent = parentIn(scope)

      const node: MindMapNode = {
        id: mintId(block.id),
        blockId: block.id,
        label: isNumbered ? `${ordinal}.${text === '' ? '' : ` ${text}`}` : text,
        kind,
        level,
        depth: parent.depth + 1,
        isDone: (kind === 'check' || kind === 'task') && isChecked(block.props),
        // Carried so activating a task node opens the task rather than the
        // block that mentions it (#1667). A task block written by a build that
        // never set one has none, and the node says so rather than inventing it.
        taskId: kind === 'task' ? stringProp(block.props, 'taskId') : null,
        wikiTarget: null,
        tags: read.tags,
        contents: [],
        detail: '',
        children: []
      }
      parent.children.push(node)
      if (level !== null) scope.stack.push({ level, node })

      // The links written in this block come before the blocks written inside
      // it, which is the order the note reads in.
      addLinks(node, block.id, read.links)
      visitBlocks(block.children ?? [], { container: node, stack: [] })
    }
  }

  visitBlocks(blocks, { container: root, stack: [] })
  finish(root, tallies, options.formatContentCount)
  return root
}

/**
 * Writes every node's `contents` and `detail` once the tallies are complete.
 *
 * `detail` is composed here rather than in either projection so the picture and
 * the accessible tree cannot drift into saying different things about the same
 * node.
 */
function finish(
  node: MindMapNode,
  tallies: Map<MindMapNode, Map<MindMapContentKind, number>>,
  format: MindMapOptions['formatContentCount']
): void {
  const counts = tallies.get(node)
  if (counts) {
    const contents: MindMapContentCount[] = []
    for (const kind of CONTENT_ORDER) {
      const count = counts.get(kind)
      if (count !== undefined) contents.push({ kind, count })
    }
    node.contents = contents
  }

  const tagged = node.tags.map((tag) => `#${tag}`).join(' ')
  const counted = format
    ? node.contents.map(({ kind, count }) => format(kind, count)).join(' · ')
    : ''
  node.detail = [tagged, counted].filter((part) => part !== '').join(' · ')

  for (const child of node.children) finish(child, tallies, format)
}
