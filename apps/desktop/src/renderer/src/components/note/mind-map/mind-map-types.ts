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
 * A wiki link is the one kind that is not a piece of THIS note: it points at
 * another document, which is a real branch rather than decoration on the label
 * that happened to contain it.
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
   * A `[[wiki link]]` lifted out of the text that held it. Always a leaf: what
   * is inside the note it names is the graph view's question, not this one's.
   */
  | 'wikiLink'
  /**
   * A fold marker: "+N more", standing for the children of its parent that the
   * children-per-parent cap held back. It is not a place in the note — it is
   * the handle that opens the branch again — so activating it expands rather
   * than navigates. `foldedCount` is how many it stands for.
   */
  | 'more'

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
  /**
   * The task a `task` node stands for, so activating it can open the task
   * rather than the block that mentions it. Null for every other kind, and for
   * a task block that carries no id yet.
   */
  taskId: string | null
  /**
   * What a `wikiLink` node points at, exactly as the link was written —
   * `Roadmap`, `Roadmap#Q3`, `diagram.pdf`. Null for every other kind.
   *
   * The target rather than a resolved id, because resolving a wiki target is a
   * database lookup and this pipeline is pure. The note page hands it to the
   * same resolver a `[[…]]` in the body goes through, so the map opens a link
   * exactly the way the editor does.
   */
  wikiTarget: string | null
  /**
   * The text of the nearest heading at or above this node, or `null` when
   * nothing above it is a heading. User content, never translated.
   *
   * It exists because a link that is written to disk can only anchor on heading
   * TEXT — block ids die with the document that minted them — and a list item
   * has no heading of its own, so it borrows its nearest ancestor's.
   *
   * Computed where the heading's text is still WHOLE, rather than read back off
   * `label`: `label` is a display string that `clipLabel` shortens past 72
   * characters, and an anchor clipped to `A very long heading th…` resolves to
   * nothing on the device that opens the canvas.
   */
  headingText: string | null
  /** Inline hash tags found in this node's own text. User content, `#` stripped. */
  tags: string[]
  /** Content sitting under this node that is not drawn, in a stable order. */
  contents: MindMapContentCount[]
  /**
   * How many nodes folded INTO this one and are therefore not drawn anywhere:
   * everything past the depth cap, plus everything the whole-map node cap had
   * no budget left for. Zero for a node that hides nothing.
   *
   * On a `more` node this is not a fold into it but what it stands for — the
   * children its parent held back — and it is what the node is labelled with.
   *
   * It is the number the "nothing disappears silently" promise is kept with, so
   * it is data rather than only wording: a caller with no translator still sees
   * exactly how much is not on the picture.
   */
  foldedCount: number
  /**
   * The second line of the node: its tags, its content counts and how much
   * folded into it, already composed. Tags are user content; the counts come
   * from `MindMapOptions.formatContentCount` and `MindMapOptions.formatMore`,
   * so this is the one place the two projections read their badge text from and
   * they cannot disagree.
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
  taskId: string | null
  wikiTarget: string | null
  headingText: string | null
  tags: string[]
  contents: MindMapContentCount[]
  foldedCount: number
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
  /**
   * Absent — the drawing library's own default, a solid outline — for every box
   * that stands for a piece of this note. A wiki-link box is dashed, so "part
   * of this note" and "another document" differ by outline as well as by
   * colour, and are still told apart without colour vision.
   */
  strokeStyle?: 'dashed'
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
 * A straight rule with no arrowheads: the connector from a parent box to one of
 * its children.
 *
 * An arrow rather than a line, and bound at both ends rather than drawn between
 * two baked coordinates. On screen the two look identical — the arrowheads are
 * off — but a saved canvas is hand-edited, and a connector whose endpoints are
 * frozen numbers comes loose the first time the user drags a node. `start`/`end`
 * name the boxes by the ids the boxes carry, which the drawing library resolves
 * into real bindings even though it regenerates every id on the way in.
 */
export interface MindMapArrowElement {
  type: 'arrow'
  id: string
  x: number
  y: number
  points: Array<[number, number]>
  /** The parent box's id. */
  start: { id: string }
  /** The child box's id. */
  end: { id: string }
  /** Both null: a mind-map branch is a rule, not a direction. */
  startArrowhead: null
  endArrowhead: null
  /** Null so a two-point connector stays a hard straight rule. */
  roundness: null
  strokeColor: string
  strokeWidth: number
  roughness: number
}

/**
 * A straight rule: the strike-through over a completed item's label. The
 * drawing surface is a bitmap with no text decorations, so "struck through" has
 * to be a real line — and an unbound one, because it belongs to the box's text
 * rather than to the space between two boxes.
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

export type MindMapElement = MindMapBoxElement | MindMapArrowElement | MindMapLineElement

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
  /**
   * Turns "two folded away" into words, for a `more` node's label and for the
   * fold badge on a node something folded into. Supplied by the caller for the
   * same reason `formatContentCount` is: a fold marker is app chrome and has to
   * be translated and pluralised, while this pipeline stays pure.
   *
   * Omitting it labels a `more` node `+2` — a number, no language — and leaves
   * the fold badge out of `detail`. `foldedCount` carries the fact either way.
   */
  formatMore?: (count: number) => string
  /**
   * Ids of the `more` nodes the user has opened, so their parents draw every
   * child instead of folding the overflow.
   *
   * A set of ids rather than a boolean per branch because a `more` node's id is
   * derived from its parent's, so the same branch opens to the same shape on
   * every rebuild — expanding twice lands on identical coordinates.
   *
   * Deliberately NOT persisted anywhere: these ids are minted from block ids,
   * which the note re-mints as soon as it is edited or opened on another
   * device, so stored expansion would go stale the moment it mattered. It lives
   * for as long as the map is open and no longer.
   */
  expanded?: ReadonlySet<string>
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
  /**
   * Drawing elements: one box per node, one bound connector per parent→child
   * edge, and a rule per line of a completed item's label.
   */
  elements: MindMapElement[]
  direction: MindMapDirection
  /** Node total including the root. Never above `MIND_MAP_MAX_NODES`. */
  nodeCount: number
  /**
   * True when the whole-map node cap is what stopped the map drawing more.
   * The host says so above the picture: a user who cannot tell a complete map
   * from a truncated one stops trusting either.
   */
  reachedNodeCap: boolean
  /** True when the note contributed nothing to branch from. */
  isEmpty: boolean
  bounds: MindMapBounds
}
