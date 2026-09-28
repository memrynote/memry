/**
 * The view block's definition: which notes a live list embedded in a note
 * shows, and how (#2488).
 *
 * On disk the block is an ordinary fenced code block tagged `memry-view`
 * whose body is this definition as JSON:
 *
 * ```memry-view
 * {
 *   "source": { "kind": "tag", "tag": "inbox-thought" },
 *   "layout": "list"
 * }
 * ```
 *
 * A fence rather than a new block type, on purpose. In the editor the block
 * is BlockNote's own `codeBlock` with `language: "memry-view"`, so every
 * process and every older build already has the node: an older Memry shows
 * the JSON as a code block and writes the same bytes back, Obsidian and
 * GitHub show a code block, and y-prosemirror never meets a node name it
 * would delete. Only the desktop renderer reads the definition and draws the
 * live list in place of the code.
 *
 * Tolerant in both directions. A definition written by a newer build may carry
 * keys this one does not know; `parseViewBlockDefinition` keeps them in `raw`
 * and `updateViewBlockDefinition` writes them back untouched. A known key
 * holding a value this build does not understand is ignored for display and
 * also kept.
 */

/** The fence info string. Also the `codeBlock` `language` prop value. */
export const VIEW_BLOCK_LANGUAGE = 'memry-view'

/** Where the rows come from. `vault` is every note outside the journal. */
export type ViewBlockSource =
  | { kind: 'vault' }
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string; andTags?: string[] }

export const VIEW_BLOCK_LAYOUTS = ['list', 'table', 'grid'] as const
export type ViewBlockLayout = (typeof VIEW_BLOCK_LAYOUTS)[number]

/** Structurally the folder view's `FilterExpression`. */
export type ViewBlockFilter =
  string | { and: ViewBlockFilter[] } | { or: ViewBlockFilter[] } | { not: ViewBlockFilter }

export interface ViewBlockOrder {
  property: string
  direction: 'asc' | 'desc'
}

export interface ViewBlockDefinition {
  source: ViewBlockSource
  /** A saved view on the source, by name. Its layout, filters and order apply. */
  view?: string
  /** Overrides the saved view's layout. */
  layout?: ViewBlockLayout
  /** ANDed onto the saved view's own filters. */
  filters?: ViewBlockFilter
  /** Overrides the saved view's order. */
  order?: ViewBlockOrder[]
  /** At most this many rows. */
  limit?: number
}

export type ParsedViewBlock =
  | {
      ok: true
      definition: ViewBlockDefinition
      /** Every key the JSON carried, known or not, for a lossless rewrite. */
      raw: Record<string, unknown>
    }
  | {
      ok: false
      /** `empty`: no definition yet. `json`: not JSON. `shape`: JSON, but no usable source. */
      reason: 'empty' | 'json' | 'shape'
      /** The object that failed the shape check, so an edit can keep its keys. */
      raw?: Record<string, unknown>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSource(value: unknown): ViewBlockSource | null {
  if (!isRecord(value)) return null
  if (value.kind === 'vault') return { kind: 'vault' }
  if (value.kind === 'folder' && typeof value.path === 'string') {
    return { kind: 'folder', path: value.path }
  }
  if (value.kind === 'tag' && typeof value.tag === 'string' && value.tag.trim() !== '') {
    const andTags = Array.isArray(value.andTags)
      ? value.andTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
      : []
    return andTags.length > 0
      ? { kind: 'tag', tag: value.tag, andTags }
      : { kind: 'tag', tag: value.tag }
  }
  return null
}

/** Bounded, because the JSON reaches this build from any device. */
const MAX_FILTER_DEPTH = 32

export function isViewBlockFilter(value: unknown, depth = 0): value is ViewBlockFilter {
  if (depth > MAX_FILTER_DEPTH) return false
  if (typeof value === 'string') return true
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  if (Array.isArray(value.and)) return value.and.every((f) => isViewBlockFilter(f, depth + 1))
  if (Array.isArray(value.or)) return value.or.every((f) => isViewBlockFilter(f, depth + 1))
  if ('not' in value) return isViewBlockFilter(value.not, depth + 1)
  return false
}

function readOrder(value: unknown): ViewBlockOrder[] | undefined {
  if (!Array.isArray(value)) return undefined
  const order = value.filter(
    (entry): entry is ViewBlockOrder =>
      isRecord(entry) &&
      typeof entry.property === 'string' &&
      entry.property !== '' &&
      (entry.direction === 'asc' || entry.direction === 'desc')
  )
  return order.length > 0
    ? order.map(({ property, direction }) => ({ property, direction }))
    : undefined
}

/**
 * Read a view block's text. Never throws: the text is note content, and a
 * block whose JSON is broken must still render (as an error the reader can
 * fix), not take the editor down.
 */
export function parseViewBlockDefinition(text: string): ParsedViewBlock {
  if (text.trim() === '') return { ok: false, reason: 'empty' }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isRecord(json)) return { ok: false, reason: 'shape' }

  const source = readSource(json.source)
  if (!source) return { ok: false, reason: 'shape', raw: json }

  const definition: ViewBlockDefinition = { source }
  if (typeof json.view === 'string' && json.view.trim() !== '') definition.view = json.view
  if (VIEW_BLOCK_LAYOUTS.includes(json.layout as ViewBlockLayout)) {
    definition.layout = json.layout as ViewBlockLayout
  }
  if (json.filters !== undefined && isViewBlockFilter(json.filters)) {
    definition.filters = json.filters
  }
  const order = readOrder(json.order)
  if (order) definition.order = order
  if (typeof json.limit === 'number' && Number.isInteger(json.limit) && json.limit > 0) {
    definition.limit = json.limit
  }

  return { ok: true, definition, raw: json }
}

/**
 * The block's text for a definition. Two-space JSON with `source` first, so
 * the fence reads as a description in any editor that shows it as code.
 */
export function serializeViewBlockDefinition(definition: Record<string, unknown>): string {
  const { source, ...rest } = definition
  const ordered: Record<string, unknown> = source === undefined ? {} : { source }
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) ordered[key] = value
  }
  return JSON.stringify(ordered, null, 2)
}

/**
 * Apply a change to the definition on disk. `raw` is the object the text
 * parsed to, so keys this build does not know survive the edit; a key set to
 * `undefined` in `patch` is removed.
 */
export function updateViewBlockDefinition(
  raw: Record<string, unknown> | undefined,
  patch: Partial<Record<keyof ViewBlockDefinition, unknown>>
): string {
  return serializeViewBlockDefinition({ ...raw, ...patch })
}

/**
 * The folder-view scope a source reads through. The whole vault is the root
 * folder, which the folder listing already treats as "every note".
 */
export function viewBlockScope(
  source: ViewBlockSource
): { kind: 'folder'; path: string } | { kind: 'tag'; tag: string; andTags?: string[] } {
  if (source.kind === 'vault') return { kind: 'folder', path: '' }
  return source
}
