/**
 * Types for the Roam Research JSON import transform.
 *
 * Pure data shapes — no electron / fs / db dependencies.
 *
 * A Roam graph export is a `RoamPage[]`. Each page has a title and an outline
 * of recursively-nested blocks. Every block has a `uid` that other blocks can
 * reference via `((uid))`.
 */

/** One block in a Roam outline (recursive). */
export interface RoamBlock {
  uid: string
  string: string
  /** Heading level 1..3 → markdown `#`..`###`. */
  heading?: number
  'create-time'?: number
  'edit-time'?: number
  children?: RoamBlock[]
}

/** One page in a Roam graph export. */
export interface RoamPage {
  title: string
  uid?: string
  'create-time'?: number
  'edit-time'?: number
  children?: RoamBlock[]
}

/** Resolved info for a single block uid, used to resolve `((uid))` refs. */
export interface BlockIndexEntry {
  /** Title of the page that contains this block. */
  pageTitle: string
  /** The block's raw `string` (pre-scrub), for fallback ref text. */
  text: string
}

/** uid → block info. Built in phase 1. */
export type BlockIndex = Map<string, BlockIndexEntry>

/**
 * How `((uid))` block references are rendered.
 *
 * Memry markdown has no Roam-style `[[page#^uid]]` block anchors, so the only
 * supported mode is the safe fallback: a wikilink to the page containing the
 * block, followed by the referenced block's text in quotes.
 */
export type BlockRefMode = 'fallback'

/** A planned note, mapped to Memry's createNote fields. */
export interface NotePlan {
  /** Page title (also drives the filename). */
  title: string
  /** Converted markdown body. */
  body: string
  /** Folder under the Roam root (e.g. `Roam` or `Roam/A/B`). */
  folder: string
  /** ISO created timestamp, or null. */
  created: string | null
  /** ISO modified timestamp, or null. */
  modified: string | null
  /** True when this page is a daily note (its title is a formatted date). */
  isDailyNote: boolean
}

export interface ImportPlan {
  notes: NotePlan[]
}
