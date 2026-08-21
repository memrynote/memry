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
 *
 * The caps are enforced here too, and they obey the same rule. A node this pass
 * declines to draw — because it is too deep, because its parent already has as
 * many children as the map draws, or because the whole map is out of budget —
 * is COUNTED on the nearest node that is drawn, never dropped. One accounting
 * invariant holds over the whole result and the tests assert it directly: every
 * CANDIDATE — a block that would be a node, or a wiki link written inside one —
 * is either drawn exactly once or counted exactly once. A wiki link goes
 * through the very same placement as a block's node, so a fan of links past the
 * children cap folds behind a "+N more" like anything else.
 */

import {
  MIND_MAP_MAX_CHILDREN,
  MIND_MAP_MAX_DEPTH,
  MIND_MAP_MAX_NODES,
  clipLabel
} from './mind-map-caps'
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

/** Shared so a build with no expansion allocates nothing per call. */
const EMPTY_EXPANSION: ReadonlySet<string> = new Set<string>()

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

/** The id of the fold marker a parent grows when its children overflow. */
export function moreNodeId(parentId: string): string {
  return `${parentId}-more`
}

/** What the projection returns: the tree, plus whether the budget ran out. */
export interface Projection {
  tree: MindMapNode
  reachedNodeCap: boolean
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
 *   ancestor that does have something to show, rather than disappearing. It
 *   adds nothing to that ancestor's fold count, because nothing was hidden:
 *   there was nothing to see in the first place. Its links fold up with its
 *   children and are placed under that ancestor.
 * - A wiki link becomes a leaf under the node its block belongs to, wherever it
 *   was written: a heading, a list item, or a paragraph that is no node itself.
 *   A block whose only content was its links therefore hands them straight to
 *   its own parent, so a bullet list of links is a fan of links and not a fan
 *   of empty boxes each holding one.
 * - A node past the depth cap, or minted once the whole-map budget is gone,
 *   folds by exactly the same route — except that it DID have something to
 *   show, so it is counted on the ancestor it folded into, which then says so.
 *   A wiki link is placed the same way and folds the same way.
 * - A parent past the children cap grows one `more` node, and everything
 *   further under that parent — later children, their whole subtrees, and any
 *   links written in them — is counted on it, so "+N more" is the true size of
 *   what is behind the fold rather than only its top row.
 */
export function projectBlocks(
  blocks: readonly MindMapSourceBlock[],
  options: MindMapOptions
): Projection {
  const root: MindMapNode = {
    id: MIND_MAP_ROOT_ID,
    blockId: null,
    // The title is user content and a long one would draw a box as tall as a
    // section, so the label cap covers it too. Clipped, never reworded.
    label: clipLabel(options.rootLabel),
    kind: 'root',
    level: null,
    depth: 0,
    isDone: false,
    taskId: null,
    wikiTarget: null,
    // The root is the note itself, so it stands under no heading: a link to it
    // reads as "this note, from the top".
    headingText: null,
    tags: [],
    contents: [],
    foldedCount: 0,
    detail: '',
    children: []
  }

  const expanded = options.expanded ?? EMPTY_EXPANSION
  /** The root is already spent, so the budget is what is left after it. */
  let budget = MIND_MAP_MAX_NODES - 1
  let reachedNodeCap = false
  /** The one fold marker a parent ever grows, so a second overflow finds it. */
  const moreNodes = new Map<MindMapNode, MindMapNode>()

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

  /** One more thing hidden behind `node`. Returned so callers can chain. */
  const fold = (node: MindMapNode): MindMapNode => {
    node.foldedCount += 1
    return node
  }

  /**
   * Where a candidate node ended up: drawn under its parent, or folded into
   * whichever node now stands for it. The second answer is not a failure — it
   * is the node that carries the count, and everything under the candidate
   * folds into the very same place, which is what keeps the accounting exact.
   */
  type Placement = { drawn: MindMapNode } | { foldedInto: MindMapNode }

  const placeUnder = (parent: MindMapNode, make: () => MindMapNode): Placement => {
    // Depth first: a parent already at the limit draws no children at all, so
    // it never grows a fold marker it would have to draw one level too deep.
    if (parent.depth + 1 > MIND_MAP_MAX_DEPTH) return { foldedInto: fold(parent) }

    const existing = moreNodes.get(parent)
    if (existing) return { foldedInto: fold(existing) }

    const isFull =
      !expanded.has(moreNodeId(parent.id)) && parent.children.length >= MIND_MAP_MAX_CHILDREN

    if (budget <= 0) {
      // Out of budget for anything, fold marker included: the map says so above
      // the picture instead, and the count still lands on a node that is drawn.
      reachedNodeCap = true
      return { foldedInto: fold(parent) }
    }

    budget -= 1
    if (!isFull) {
      const node = make()
      parent.children.push(node)
      return { drawn: node }
    }

    const more: MindMapNode = {
      id: moreNodeId(parent.id),
      blockId: null,
      // Written in `finish`, from the count it ends up standing for.
      label: '',
      kind: 'more',
      level: null,
      depth: parent.depth + 1,
      isDone: false,
      // A fold marker stands for content, it is not content: it opens nothing
      // outside this note and it is not a task.
      taskId: null,
      wikiTarget: null,
      // What it folds away lives under the same heading its parent does, so a
      // saved canvas can still point at the section the missing rows are in.
      headingText: parent.headingText,
      tags: [],
      contents: [],
      foldedCount: 0,
      detail: '',
      children: []
    }
    moreNodes.set(parent, more)
    parent.children.push(more)
    return { foldedInto: fold(more) }
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
   *
   * Placed through `placeUnder`, exactly like a block's own node: a link is a
   * node the map owes the user an answer about, so it is subject to every cap
   * and is counted when a cap holds it back. A heading with thirty links folds
   * behind one "+N more" rather than drawing thirty boxes, and `folded` — set
   * when the whole scope is already behind a fold — counts them there instead.
   */
  const addLinks = (
    parent: MindMapNode,
    blockId: string,
    links: readonly InlineWikiLink[],
    folded: MindMapNode | null
  ): void => {
    links.forEach((link, index) => {
      if (folded) {
        // Behind a fold. A link had something to show, so it is counted on the
        // node standing for the fold, the same as any other node would be.
        fold(folded)
        return
      }
      placeUnder(parent, () => ({
        id: mintId(`${blockId}-link-${index + 1}`),
        blockId: null,
        label: clipLabel(link.label),
        kind: 'wikiLink',
        level: null,
        depth: parent.depth + 1,
        isDone: false,
        taskId: null,
        wikiTarget: link.target,
        // The heading the LINK is written under, in THIS note — not anything
        // about the note it names. It is the fallback a saved canvas falls back
        // to when the target cannot be resolved to a real note.
        headingText: parent.headingText,
        tags: [],
        contents: [],
        foldedCount: 0,
        detail: '',
        children: []
      }))
    })
  }

  /**
   * One level of containment: the node holding these blocks, and the headings
   * open inside it, shallowest first. A container gets its own stack so its
   * headings cannot escape it; the top level's container is the root.
   *
   * `folded` is set when this whole scope is behind a fold. Nothing here draws
   * then; every node it would have drawn is counted on that one node, which is
   * how a fold marker ends up naming the true size of what is behind it.
   */
  interface Scope {
    container: MindMapNode
    stack: Array<{ level: number; node: MindMapNode }>
    folded: MindMapNode | null
  }

  /** Whatever a block written here belongs to: the open heading, else the container. */
  const parentIn = (scope: Scope): MindMapNode =>
    scope.folded ??
    (scope.stack.length > 0 ? scope.stack[scope.stack.length - 1].node : scope.container)

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
        addLinks(parentIn(scope), block.id, readInline(block.content).links, scope.folded)
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

      // Nothing to show: no box, no level-stack entry, and no fold count — an
      // empty block hides nothing, so counting it would send the user looking
      // for content that was never there. Its children fold up to whatever this
      // block's own parent was, which is the same route a capped node takes,
      // and its links fold up with them — `- [[Roadmap]]` is a branch to
      // Roadmap, not an empty box holding one.
      if (text === '' && read.tags.length === 0) {
        addLinks(parentIn(scope), block.id, read.links, scope.folded)
        visitBlocks(block.children ?? [], scope)
        continue
      }

      // Already behind a fold: this had something to show, so it is counted,
      // and everything under it is counted on the very same node.
      if (scope.folded) {
        fold(scope.folded)
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

      const placement = placeUnder(parent, () => ({
        id: mintId(block.id),
        blockId: block.id,
        label: clipLabel(isNumbered ? `${ordinal}.${text === '' ? '' : ` ${text}`}` : text),
        kind,
        level,
        depth: parent.depth + 1,
        isDone: (kind === 'check' || kind === 'task') && isChecked(block.props),
        // Carried so activating a task node opens the task rather than the
        // block that mentions it (#1667). A task block written by a build that
        // never set one has none, and the node says so rather than inventing it.
        taskId: kind === 'task' ? stringProp(block.props, 'taskId') : null,
        wikiTarget: null,
        // A heading anchors on itself; everything else borrows whatever heading
        // it sits under. `parent` is the open heading when there is one and the
        // enclosing container otherwise, and a container already carries the
        // heading IT sits under — so one read walks the whole chain, containers
        // and their fresh level stacks included.
        //
        // `text`, not `label`: `label` has been through `clipLabel`, and an
        // anchor clipped mid-heading resolves to nothing on the device that
        // opens the saved canvas. The whole text is also what `extractHeadings`
        // reads back on the other side — both drop content-less inline specs (a
        // hash tag among them), so a heading tagged inline still matches.
        headingText: kind === 'heading' ? text : parent.headingText,
        tags: read.tags,
        contents: [],
        foldedCount: 0,
        detail: '',
        children: []
      }))

      if ('drawn' in placement) {
        if (level !== null) scope.stack.push({ level, node: placement.drawn })
        // The links written in this block come before the blocks written inside
        // it, which is the order the note reads in.
        addLinks(placement.drawn, block.id, read.links, null)
        visitBlocks(block.children ?? [], {
          container: placement.drawn,
          stack: [],
          folded: null
        })
        continue
      }

      // Not drawn. A heading that folded never joins the level stack, so what
      // follows it attaches to the nearest node that IS drawn and folds there
      // in its turn — exactly what an unlabelled heading has always done. Its
      // links go with it: they were inside a node the map is not drawing, so
      // they are counted on the node that stands for it.
      addLinks(parent, block.id, read.links, placement.foldedInto)
      visitBlocks(block.children ?? [], {
        container: parent,
        stack: [],
        folded: placement.foldedInto
      })
    }
  }

  visitBlocks(blocks, { container: root, stack: [], folded: null })
  finish(root, tallies, options)
  return { tree: root, reachedNodeCap }
}

/**
 * Writes every node's `contents`, `detail` and — for a fold marker — its label,
 * once the tallies and the fold counts are complete.
 *
 * `detail` is composed here rather than in either projection so the picture and
 * the accessible tree cannot drift into saying different things about the same
 * node.
 */
function finish(
  node: MindMapNode,
  tallies: Map<MindMapNode, Map<MindMapContentKind, number>>,
  options: MindMapOptions
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

  const { formatContentCount, formatMore } = options

  // A fold marker IS its count, so the count is its label and never also a
  // badge underneath it. Without a translator it still says how much, in digits
  // rather than in words — the number is the promise, the wording is chrome.
  if (node.kind === 'more') {
    // Clipped like any other label: a locale can word this far longer than
    // English does, and the cap has to mean the same thing in all of them.
    node.label = clipLabel(formatMore ? formatMore(node.foldedCount) : `+${node.foldedCount}`)
  }

  const tagged = node.tags.map((tag) => `#${tag}`).join(' ')
  const counted = formatContentCount
    ? node.contents.map(({ kind, count }) => formatContentCount(kind, count)).join(' · ')
    : ''
  const folded =
    node.kind !== 'more' && node.foldedCount > 0 && formatMore ? formatMore(node.foldedCount) : ''
  node.detail = [tagged, counted, folded].filter((part) => part !== '').join(' · ')

  for (const child of node.children) finish(child, tallies, options)
}
