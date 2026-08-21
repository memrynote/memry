/**
 * Public shapes of the note mind map.
 *
 * `buildMindMap` (see `build-mind-map.ts`) is the only entry point into this
 * directory; everything here describes what goes in and what comes back out.
 * The projection, the layout and the element minting are private steps behind
 * that one function, so none of their intermediate shapes are exported.
 *
 * Nothing in this file imports the drawing library: the element descriptors are
 * plain data, which is what keeps the whole pipeline testable without a DOM and
 * without pulling a renderer chunk into a unit test.
 */

/** Direction the tree grows in — derived from the document direction. */
export type MindMapDirection = 'ltr' | 'rtl'

/**
 * The structural subset of a BlockNote block the map reads.
 *
 * Deliberately loose: `props` and `content` are `unknown` because a block tree
 * can carry any registered custom spec, and every read of them here is guarded.
 */
export interface MindMapSourceBlock {
  id: string
  type: string
  props?: unknown
  content?: unknown
  children?: readonly MindMapSourceBlock[]
}

/**
 * What a node stands for.
 *
 * The governing rule is that containers branch and content does not: every kind
 * here is something that really holds structure, so flattening it would destroy
 * something the user wrote. Content — tables, code, images, quotes, embeds,
 * bookmarks, files — is counted on its parent instead (see
 * `MindMapContentKind`) rather than drawn, and is never silently dropped.
 *
 * Wiki links become their own kind in later work.
 */
export type MindMapNodeKind =
  | 'root'
  | 'heading'
  /** `bulletListItem`. */
  | 'bullet'
  /** `numberedListItem`; its number is kept at the front of the label. */
  | 'numbered'
  /** `checkListItem`; `isDone` follows its checkbox. */
  | 'check'
  /** Memry's `taskBlock`; `isDone` follows its checkbox. */
  | 'task'
  /** `toggleListItem` — branches into its children rather than hiding them. */
  | 'toggle'
  /** Memry's `callout` — branches into its children. */
  | 'callout'

/**
 * Content that is not structure. It never becomes a node; it is counted on the
 * nearest node above it, which then carries a badge naming what is there.
 *
 * `embed` covers `youtubeEmbed`, `video` and `audio`: all three are a piece of
 * media the map cannot draw and would otherwise lose.
 */
export type MindMapContentKind =
  'table' | 'code' | 'image' | 'quote' | 'embed' | 'bookmark' | 'file'

/** How much of one content kind sits under a node. Never zero. */
export interface MindMapContentCount {
  kind: MindMapContentKind
  count: number
}

/** A node in the logical tree, before any coordinates exist. */
export interface MindMapNode {
  /** Stable within one map. Derived from the source block, never random. */
  id: string
  /** The block this node came from; `null` for the root, which is the title. */
  blockId: string | null
  /** User content. Never translated. */
  label: string
  kind: MindMapNodeKind
  /** Heading level as written (1–6); `null` for everything else. */
  level: number | null
  /** Distance from the root. The root is 0. */
  depth: number
  /** A ticked checklist item or task. Always false for other kinds. */
  isDone: boolean
  /** Inline hash tags found in this node's own text. User content, `#` stripped. */
  tags: string[]
  /** Content sitting under this node that is not drawn, in a stable order. */
  contents: MindMapContentCount[]
  /**
   * The second line of the node: its tags and its content counts, already
   * composed. Tags are user content; the counts come from
   * `MindMapOptions.formatContentCount`, so this is the one place the two
   * projections read their badge text from and they cannot disagree.
   */
  detail: string
  children: MindMapNode[]
}

/** The same node once the layout has placed and sized it. */
export interface MindMapPositionedNode {
  id: string
  blockId: string | null
  label: string
  kind: MindMapNodeKind
  level: number | null
  depth: number
  isDone: boolean
  tags: string[]
  contents: MindMapContentCount[]
  detail: string
  parentId: string | null
  x: number
  y: number
  width: number
  height: number
}

/** A node drawn as a labelled box. */
export interface MindMapBoxElement {
  type: 'rectangle'
  id: string
  x: number
  y: number
  width: number
  height: number
  strokeColor: string
  backgroundColor: string
  fillStyle: 'solid'
  strokeWidth: number
  roughness: number
  roundness: { type: number }
  label: {
    text: string
    fontSize: number
    textAlign: 'left' | 'right'
    verticalAlign: 'middle'
    strokeColor: string
  }
  /**
   * A `memry://` deep link back into the note, present only when the build was
   * given a note id. It is what makes a drawn box clickable at all: the drawing
   * surface is a bitmap with no DOM, and its link hit test — the whole bounding
   * box, in view mode — is the only handle a click has on a node.
   *
   * A block anchor is right HERE and only here: these elements are drawn for
   * the session that minted them, and a block id lives exactly as long as the
   * document that minted it. A saved canvas outlives that, so the file's links
   * will carry heading text instead.
   */
  link?: string
}

/**
 * A straight rule: the connector from a parent box to one of its children, or
 * the strike-through over a completed item's label. The drawing surface is a
 * bitmap with no text decorations, so "struck through" has to be a real line.
 */
export interface MindMapLineElement {
  type: 'line'
  id: string
  x: number
  y: number
  points: Array<[number, number]>
  strokeColor: string
  strokeWidth: number
  roughness: number
}

export type MindMapElement = MindMapBoxElement | MindMapLineElement

/** Bounding box of every positioned node, so the host can fit the view. */
export interface MindMapBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MindMapOptions {
  /** The note title, used as the root label. User content; never translated. */
  rootLabel: string
  /** Defaults to `'ltr'`. In `'rtl'` the tree mirrors so it grows with the
   * reading direction rather than against it. */
  direction?: MindMapDirection
  /**
   * The note the map is of. Given it, every box is minted with a `memry://`
   * deep link back to its own block, which is how a click on the drawing finds
   * out which node it landed on. Left out, the map draws exactly as before and
   * only the tree projection is clickable.
   */
  noteId?: string
  /**
   * Turns "three tables" into words. Supplied by the caller because a counter
   * badge is app chrome and has to be translated and pluralised, while this
   * pipeline stays pure — it has no translator and must not grow one.
   *
   * Omitting it keeps the counts in `contents` and leaves them out of `detail`:
   * the data never disappears, only its wording.
   */
  formatContentCount?: (kind: MindMapContentKind, count: number) => string
}

/**
 * One result carrying all three layers, so a caller (or a test) can assert at
 * whichever level suits it without a second seam into the pipeline.
 */
export interface MindMap {
  /** The logical tree, rooted at the note title. */
  tree: MindMapNode
  /** Every node with coordinates, in depth-first order starting at the root. */
  nodes: MindMapPositionedNode[]
  /** Drawing elements: one box per node, one connector per parent→child edge. */
  elements: MindMapElement[]
  direction: MindMapDirection
  /** Node total including the root. */
  nodeCount: number
  /** True when the note contributed nothing to branch from. */
  isEmpty: boolean
  bounds: MindMapBounds
}
