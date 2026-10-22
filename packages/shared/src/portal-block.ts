/**
 * The portal block's definition: a live window onto another note, one block of
 * another note, or the blocks a search finds. Edits made through the window go
 * to the source; the host note stores only this reference.
 *
 * On disk the block is an ordinary fenced code block tagged `memry-portal`
 * whose body is this definition as JSON:
 *
 * ```memry-portal
 * { "note": "<noteId>", "block": "chl-7f2a", "hidden": ["b9x1"] }
 * ```
 *
 * A fence rather than a new block type, for the same reason as `memry-view`
 * (see `view-block.ts`): in the editor it is BlockNote's own `codeBlock` with
 * `language: "memry-portal"`, so every process and every older build already
 * has the node. An older Memry shows the JSON as a code block and writes the
 * same bytes back, and y-prosemirror never meets a node name it would delete.
 * Only the desktop renderer draws the live window, and iOS draws a read-only
 * slice resolved by the Rust core.
 *
 * A block target is addressed by an anchor: the literal text ` ^anchor` at the
 * end of the source block (Obsidian's block-id syntax). It is ordinary text,
 * so it survives any markdown round trip, and existing `^id` text in a vault
 * keeps meaning exactly what it did.
 *
 * Tolerant in both directions, like `memry-view`: a key this build does not
 * know is kept in `raw` and written back untouched, and a definition this
 * build cannot read is shown as invalid and its bytes are left alone.
 */

/** The fence info string. Also the `codeBlock` `language` prop value. */
export const PORTAL_BLOCK_LANGUAGE = 'memry-portal'

/** Most results a search portal draws. */
export const PORTAL_SEARCH_MAX_LIMIT = 200
export const PORTAL_SEARCH_DEFAULT_LIMIT = 50

/** Portals inside portals open this many levels, then show a link instead. */
export const PORTAL_MAX_DEPTH = 3

export type PortalTarget =
  | { kind: 'note'; note: string }
  /** `block` is an anchor, without the leading caret. */
  | { kind: 'block'; note: string; block: string }
  | { kind: 'search'; text?: string; tag?: string; limit: number }

export interface PortalDefinition {
  target: PortalTarget
  /** Anchors of descendant blocks this portal does not show. Never the root. */
  hidden: string[]
}

export type PortalStatus =
  'ok' | 'missing-note' | 'missing-block' | 'locked' | 'cycle' | 'too-deep' | 'not-synced'

export type ParsedPortal =
  | {
      ok: true
      definition: PortalDefinition
      /** Every key the JSON carried, known or not, for a lossless rewrite. */
      raw: Record<string, unknown>
    }
  | {
      ok: false
      /** `empty`: no definition yet. `json`: not JSON. `shape`: JSON, but no usable target. */
      reason: 'empty' | 'json' | 'shape'
      raw?: Record<string, unknown>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function readHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) if (isAnchor(entry)) seen.add(entry)
  return [...seen]
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
  if (json.block === undefined) return { kind: 'note', note }
  return isAnchor(json.block) ? { kind: 'block', note, block: json.block } : null
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

  return { ok: true, definition: { target, hidden: readHidden(json.hidden) }, raw: json }
}

/** The JSON keys a target writes, in on-disk order. */
function targetKeys(target: PortalTarget): Record<string, unknown> {
  if (target.kind === 'note') return { note: target.note }
  if (target.kind === 'block') return { note: target.note, block: target.block }
  const search: Record<string, unknown> = {}
  if (target.text !== undefined) search.text = target.text
  if (target.tag !== undefined) search.tag = target.tag
  search.limit = target.limit
  return { search }
}

/**
 * The block's text for a definition. Two-space JSON, target first, then
 * `hidden` when there is any. Keys from `raw` that this build does not manage
 * are kept after those, so a newer build's additions survive an edit.
 */
export function serializePortalDefinition(
  definition: PortalDefinition,
  raw?: Record<string, unknown>
): string {
  const ordered: Record<string, unknown> = targetKeys(definition.target)
  if (definition.hidden.length > 0) ordered.hidden = definition.hidden
  const managed = new Set(['note', 'block', 'search', 'hidden'])
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!managed.has(key) && value !== undefined) ordered[key] = value
  }
  return JSON.stringify(ordered, null, 2)
}

/** The note a target reads from, or null for a search. */
export function portalSourceNote(target: PortalTarget): string | null {
  return target.kind === 'search' ? null : target.note
}
