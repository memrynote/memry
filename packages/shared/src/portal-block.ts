/**
 * The portal block's definition: a live window onto part of another note, or
 * the blocks a search finds. Edits made through the window go to the source;
 * the host note stores only this reference.
 *
 * On disk the block is an ordinary fenced code block tagged `memry-portal`
 * whose body is this definition as JSON (format v1):
 *
 * ```memry-portal
 * {
 *   "v": 1,
 *   "note": "<noteId>",
 *   "blocks": ["k3x9a2", "p8m2qa"],
 *   "open": { "k3x9a2": { "show": ["n4c8x1"] } }
 * }
 * ```
 *
 * `blocks` are the root anchors (empty or absent: the whole note). `open`
 * says which blocks show their children: a block absent from `open` is
 * collapsed, `{"hide": [...]}` shows every child except those, `{"show": [...]}`
 * shows only those. A block is visible iff it is a root, or its parent is
 * visible and open and lets it through (see `portal-resolve.ts`).
 *
 * A fence rather than a new block type, for the same reason as `memry-view`
 * (see `view-block.ts`): in the editor it is BlockNote's own `codeBlock` with
 * `language: "memry-portal"`, so every process and every older build already
 * has the node. Only the desktop renderer draws the live window, and iOS
 * draws a read-only slice resolved by the Rust core.
 *
 * A block is addressed by an anchor: the literal text ` ^anchor` at the end of
 * the source block (Obsidian's block-id syntax). It is ordinary text, so it
 * survives any markdown round trip.
 *
 * Tolerant in both directions, like `memry-view`: a key this build does not
 * know is kept in `raw` and written back untouched, and a definition this
 * build cannot read is shown as invalid and its bytes are left alone.
 */

import { isRecord } from './is-record'

/** The fence info string. Also the `codeBlock` `language` prop value. */
export const PORTAL_BLOCK_LANGUAGE = 'memry-portal'

/** Most results a search portal draws. */
export const PORTAL_SEARCH_MAX_LIMIT = 200
export const PORTAL_SEARCH_DEFAULT_LIMIT = 50

/** Portals inside portals open this many levels, then show a link instead. */
export const PORTAL_MAX_DEPTH = 3

export type PortalOpen = { mode: 'hide'; ids: string[] } | { mode: 'show'; ids: string[] }

export type PortalTarget =
  /** `hide` are the anchors of blocks (and their descendants) the portal leaves out. */
  | { kind: 'note'; note: string; hide: string[] }
  /** `blocks` are root anchors, without the leading caret, in portal order. */
  | { kind: 'blocks'; note: string; blocks: string[]; open: Record<string, PortalOpen> }
  | { kind: 'search'; text?: string; tag?: string; limit: number }

export interface PortalDefinition {
  v: 1
  target: PortalTarget
  /** Every key the JSON carried, known or not, for a lossless rewrite. */
  raw: Record<string, unknown>
}

export type PortalStatus =
  | 'ok'
  | 'missing-note'
  | 'missing-block'
  | 'locked'
  | 'cycle'
  | 'too-deep'
  | 'not-synced'

export type ParsedPortal =
  | { ok: true; definition: PortalDefinition }
  | {
      ok: false
      /** `empty`: no definition yet. `json`: not JSON. `shape`: JSON, but no usable target. */
      reason: 'empty' | 'json' | 'shape'
      raw?: Record<string, unknown>
    }

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

const ANCHOR_BODY = '[a-z0-9][a-z0-9-]{3,31}'
const ANCHOR_PATTERN = new RegExp(`^${ANCHOR_BODY}$`)
const ANCHOR_SUFFIX = new RegExp(`(?:^|\\s)\\^(${ANCHOR_BODY})\\s*$`)

const ANCHOR_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function isAnchor(value: unknown): value is string {
  return typeof value === 'string' && ANCHOR_PATTERN.test(value)
}

/**
 * A fresh anchor: six characters from `[a-z0-9]`. `random` returns a number in
 * `[0, 1)` and is injectable so tests are deterministic.
 */
export function makeAnchor(random: () => number = Math.random): string {
  let anchor = ''
  for (let i = 0; i < 6; i += 1) {
    anchor += ANCHOR_ALPHABET[Math.min(ANCHOR_ALPHABET.length - 1, Math.floor(random() * 36))]
  }
  return anchor
}

/** The text appended to a block to give it the anchor: a space, a caret, the anchor. */
export function anchorSuffix(anchor: string): string {
  return ` ^${anchor}`
}

/** The anchor a block's text ends with, or null. A caret inside a word is not an anchor. */
export function extractAnchor(blockText: string): string | null {
  const match = ANCHOR_SUFFIX.exec(blockText)
  return match ? match[1] : null
}

/** The block's text without its trailing anchor. */
export function stripAnchor(blockText: string): string {
  const match = ANCHOR_SUFFIX.exec(blockText)
  return match ? blockText.slice(0, match.index) : blockText
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function readAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) if (isAnchor(entry)) seen.add(entry)
  return [...seen]
}

function readOpen(value: unknown): Record<string, PortalOpen> {
  const open: Record<string, PortalOpen> = {}
  if (!isRecord(value)) return open
  for (const [anchor, entry] of Object.entries(value)) {
    if (!isAnchor(anchor) || !isRecord(entry)) continue
    if (Array.isArray(entry.show)) open[anchor] = { mode: 'show', ids: readAnchors(entry.show) }
    else if (Array.isArray(entry.hide))
      open[anchor] = { mode: 'hide', ids: readAnchors(entry.hide) }
  }
  return open
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return PORTAL_SEARCH_DEFAULT_LIMIT
  }
  return Math.min(value, PORTAL_SEARCH_MAX_LIMIT)
}

/** The target as stored, or null when this build cannot read it. */
export function readPortalTarget(json: Record<string, unknown>): PortalTarget | null {
  if (isRecord(json.search)) {
    const text = readNonEmptyString(json.search.text)
    const tag = readNonEmptyString(json.search.tag)
    if (text === undefined && tag === undefined) return null
    const target: PortalTarget = { kind: 'search', limit: readLimit(json.search.limit) }
    if (text !== undefined) target.text = text
    if (tag !== undefined) target.tag = tag
    return target
  }
  const note = readNonEmptyString(json.note)
  if (note === undefined) return null
  const blocks = readAnchors(json.blocks)
  if (blocks.length === 0) return { kind: 'note', note, hide: readAnchors(json.hide) }
  return { kind: 'blocks', note, blocks, open: readOpen(json.open) }
}

/**
 * Read a portal block's text. Never throws: the text is note content, and a
 * block whose JSON is broken must still render (as an error the reader can
 * fix), not take the editor down.
 */
export function parsePortalDefinition(text: string): ParsedPortal {
  if (text.trim() === '') return { ok: false, reason: 'empty' }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isRecord(json)) return { ok: false, reason: 'shape' }

  const target = readPortalTarget(json)
  if (!target) return { ok: false, reason: 'shape', raw: json }

  return { ok: true, definition: { v: 1, target, raw: json } }
}

const MANAGED_KEYS = new Set(['v', 'note', 'blocks', 'open', 'search'])

function isManagedKey(key: string, target: PortalTarget): boolean {
  return MANAGED_KEYS.has(key) || (key === 'hide' && target.kind === 'note')
}

/** The JSON keys a target writes, in on-disk order. */
function targetKeys(target: PortalTarget): Record<string, unknown> {
  if (target.kind === 'note') {
    return target.hide.length > 0 ? { note: target.note, hide: target.hide } : { note: target.note }
  }
  if (target.kind === 'blocks') {
    const keys: Record<string, unknown> = { note: target.note, blocks: target.blocks }
    const open: Record<string, unknown> = {}
    for (const [anchor, entry] of Object.entries(target.open)) {
      open[anchor] = { [entry.mode]: entry.ids }
    }
    if (Object.keys(open).length > 0) keys.open = open
    return keys
  }
  const search: Record<string, unknown> = {}
  if (target.text !== undefined) search.text = target.text
  if (target.tag !== undefined) search.tag = target.tag
  search.limit = target.limit
  return { search }
}

/**
 * The block's text for a definition. Two-space JSON, keys `v`, `note`,
 * `blocks`, `open` (a whole-note portal: `v`, `note`, `hide`). Keys from `raw` that this build does not manage are kept
 * after those, so a newer build's additions survive an edit.
 */
export function serializePortalDefinition(definition: PortalDefinition): string {
  const ordered: Record<string, unknown> = { v: 1, ...targetKeys(definition.target) }
  for (const [key, value] of Object.entries(definition.raw)) {
    if (!isManagedKey(key, definition.target) && value !== undefined) ordered[key] = value
  }
  return JSON.stringify(ordered, null, 2)
}

// ---------------------------------------------------------------------------
// Edits. Pure: each returns a new definition. A definition that is not a
// `blocks` target (a note or a search) has no roots or folds, so it comes back
// unchanged.
// ---------------------------------------------------------------------------

type BlocksTarget = Extract<PortalTarget, { kind: 'blocks' }>

function withBlocks(
  def: PortalDefinition,
  edit: (target: BlocksTarget) => BlocksTarget | null
): PortalDefinition {
  if (def.target.kind !== 'blocks') return def
  const next = edit({
    ...def.target,
    blocks: [...def.target.blocks],
    open: { ...def.target.open }
  })
  return next ? { ...def, target: next } : def
}

/** Add a root after `afterAnchor`, or at the end. A root already listed stays put. */
export function addRoot(
  def: PortalDefinition,
  anchor: string,
  afterAnchor?: string
): PortalDefinition {
  return withBlocks(def, (t) => {
    if (t.blocks.includes(anchor)) return t
    const at = afterAnchor === undefined ? -1 : t.blocks.indexOf(afterAnchor)
    t.blocks.splice(at < 0 ? t.blocks.length : at + 1, 0, anchor)
    return t
  })
}

/** Drop a root. Null when it is the only root: a portal never shows nothing. */
export function removeRoot(def: PortalDefinition, anchor: string): PortalDefinition | null {
  if (def.target.kind !== 'blocks') return def
  if (!def.target.blocks.includes(anchor)) return def
  if (def.target.blocks.length === 1) return null
  return withBlocks(def, (t) => ({ ...t, blocks: t.blocks.filter((a) => a !== anchor) }))
}

/**
 * Make the parent the single root and keep what the user saw: the previous
 * roots become the parent's only shown children.
 */
export function includeParent(def: PortalDefinition, parentAnchor: string): PortalDefinition {
  return withBlocks(def, (t) => {
    if (t.blocks.includes(parentAnchor)) return t
    t.open[parentAnchor] = { mode: 'show', ids: t.blocks }
    return { ...t, blocks: [parentAnchor] }
  })
}

/** Show every child of the block. */
export function expandAll(def: PortalDefinition, blockAnchor: string): PortalDefinition {
  return withBlocks(def, (t) => {
    t.open[blockAnchor] = { mode: 'hide', ids: [] }
    return t
  })
}

/** Fold the block's children away. */
export function collapse(def: PortalDefinition, blockAnchor: string): PortalDefinition {
  return withBlocks(def, (t) => {
    delete t.open[blockAnchor]
    return t
  })
}

export function showChild(
  def: PortalDefinition,
  parentAnchor: string,
  childAnchor: string
): PortalDefinition {
  return withBlocks(def, (t) => {
    const entry = t.open[parentAnchor]
    if (!entry) t.open[parentAnchor] = { mode: 'show', ids: [childAnchor] }
    else if (entry.mode === 'show') {
      if (!entry.ids.includes(childAnchor)) {
        t.open[parentAnchor] = { mode: 'show', ids: [...entry.ids, childAnchor] }
      }
    } else {
      t.open[parentAnchor] = { mode: 'hide', ids: entry.ids.filter((a) => a !== childAnchor) }
    }
    return t
  })
}

export function hideChild(
  def: PortalDefinition,
  parentAnchor: string,
  childAnchor: string
): PortalDefinition {
  return withBlocks(def, (t) => {
    const entry = t.open[parentAnchor]
    if (!entry) return t
    if (entry.mode === 'show') {
      t.open[parentAnchor] = { mode: 'show', ids: entry.ids.filter((a) => a !== childAnchor) }
    } else if (!entry.ids.includes(childAnchor)) {
      t.open[parentAnchor] = { mode: 'hide', ids: [...entry.ids, childAnchor] }
    }
    return t
  })
}

/** A child made through the portal must stay visible: collapsed and show-mode parents list it. */
export function noteCreatedChild(
  def: PortalDefinition,
  parentAnchor: string,
  childAnchor: string
): PortalDefinition {
  const entry = def.target.kind === 'blocks' ? def.target.open[parentAnchor] : undefined
  return entry?.mode === 'hide' ? def : showChild(def, parentAnchor, childAnchor)
}

/** A sibling made after a root through the portal becomes a root so it stays visible. */
export function noteCreatedRootSibling(
  def: PortalDefinition,
  afterAnchor: string,
  newAnchor: string
): PortalDefinition {
  return addRoot(def, newAnchor, afterAnchor)
}

// ---------------------------------------------------------------------------
// Whole-note portals: a deny list. Each returns the definition unchanged when
// the target is not a note.
// ---------------------------------------------------------------------------

function withHide(def: PortalDefinition, edit: (hide: string[]) => string[]): PortalDefinition {
  const { target } = def
  if (target.kind !== 'note') return def
  const hide = edit(target.hide)
  return hide.length === target.hide.length && hide.every((a, i) => a === target.hide[i])
    ? def
    : { ...def, target: { ...target, hide } }
}

/** Leave the block (and everything under it) out of a whole-note portal. */
export function hideBlock(def: PortalDefinition, anchor: string): PortalDefinition {
  return withHide(def, (hide) => (hide.includes(anchor) ? hide : [...hide, anchor]))
}

/** Bring a hidden block back. */
export function unhideBlock(def: PortalDefinition, anchor: string): PortalDefinition {
  return withHide(def, (hide) => hide.filter((a) => a !== anchor))
}

/** Bring every hidden block back. */
export function unhideAll(def: PortalDefinition): PortalDefinition {
  return withHide(def, () => [])
}

/** The note a target reads from, or null for a search. */
export function portalSourceNote(target: PortalTarget): string | null {
  return target.kind === 'search' ? null : target.note
}
