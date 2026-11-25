import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import type { NoteCoverSync } from '@memry/contracts/sync-payloads'
import { syncState } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import {
  COVER_CREDIT_FRONTMATTER_KEY,
  COVER_CREDIT_URL_FRONTMATTER_KEY,
  COVER_FOCUS_FRONTMATTER_KEY,
  COVER_FOCUS_X_FRONTMATTER_KEY,
  COVER_FRONTMATTER_KEY,
  COVER_HEIGHT_FRONTMATTER_KEY,
  COVER_ZOOM_FRONTMATTER_KEY,
  DEFAULT_COVER_FRAMING,
  clampCoverFocus,
  clampCoverHeight,
  clampCoverZoom,
  isCoverCreditUrlValue,
  isCoverCreditValue,
  isCoverFocusValue,
  isCoverHeightValue,
  isCoverValue,
  isCoverZoomValue,
  parseCoverFraming,
  parseCoverValue
} from '@memry/shared/cover-image'
import type { NoteFrontmatter } from '../../vault/frontmatter'
import { COVER_MARKER_KEY_PREFIX } from './note-cover-marker-key'

/**
 * The note's cover as the push payload carries it, or `null` when the file has
 * none. Each key is read through the same value gate that reserves it from the
 * user's properties, so `cover: Hardback` on a book note is not a cover here
 * either.
 */
export function noteCoverFromFrontmatter(frontmatter: NoteFrontmatter): NoteCoverSync | null {
  const ref = frontmatter[COVER_FRONTMATTER_KEY]
  if (!isCoverValue(ref)) return null
  const focus = frontmatter[COVER_FOCUS_FRONTMATTER_KEY]
  const credit = frontmatter[COVER_CREDIT_FRONTMATTER_KEY]
  const creditUrl = frontmatter[COVER_CREDIT_URL_FRONTMATTER_KEY]
  // Sent in full, defaults included, so a receiver can read an omission as an
  // older sender rather than a reset (see `NoteCoverSyncSchema`).
  const framing = parseCoverValue(ref)?.kind === 'image' ? parseCoverFraming(frontmatter) : null
  return {
    ref,
    ...(isCoverFocusValue(focus) ? { focus: clampCoverFocus(focus) } : {}),
    ...(framing ? { focusX: framing.focusX, zoom: framing.zoom, height: framing.height } : {}),
    ...(isCoverCreditValue(credit) ? { credit } : {}),
    ...(isCoverCreditUrlValue(creditUrl) ? { creditUrl } : {})
  }
}

/** Removes a cover key only when its value is cover data, never a user property. */
function deleteGated(
  frontmatter: NoteFrontmatter,
  key: string,
  gate: (value: unknown) => boolean
): void {
  if (gate(frontmatter[key])) delete frontmatter[key]
}

/**
 * A framing key added after `coverFocus`, with the gate that reserves it, the
 * clamp it is written through, and the payload field that carries it.
 */
const LATER_FRAMING_KEYS = [
  {
    key: COVER_FOCUS_X_FRONTMATTER_KEY,
    field: 'focusX',
    gate: isCoverFocusValue,
    clamp: clampCoverFocus,
    fallback: DEFAULT_COVER_FRAMING.focusX
  },
  {
    key: COVER_ZOOM_FRONTMATTER_KEY,
    field: 'zoom',
    gate: isCoverZoomValue,
    clamp: clampCoverZoom,
    fallback: DEFAULT_COVER_FRAMING.zoom
  },
  {
    key: COVER_HEIGHT_FRONTMATTER_KEY,
    field: 'height',
    gate: isCoverHeightValue,
    clamp: clampCoverHeight,
    fallback: DEFAULT_COVER_FRAMING.height
  }
] as const

/**
 * Writes a remote cover into frontmatter, the way `useNoteCover` writes a local
 * one: the ref, and with it either its own framing and credit or none of them.
 * `null` removes the cover. A ref this build does not read as a cover is left
 * out rather than written, because it would land as a user property.
 *
 * `coverFocusX`, `coverZoom` and `coverHeight` are the exception. A sender that
 * predates them omits them, so for the same `ref` the local values stay rather
 * than an older device's unrelated edit resetting the framing. A default value
 * is not written, so the file keeps reading the way it did before the key
 * existed.
 */
export function applyNoteCoverToFrontmatter(
  frontmatter: NoteFrontmatter,
  cover: NoteCoverSync | null
): NoteFrontmatter {
  const next: NoteFrontmatter = { ...frontmatter }
  if (cover !== null && !isCoverValue(cover.ref)) return next
  // `cover: Hardback` is the user's own property; a remote cover never replaces it.
  if (
    cover !== null &&
    COVER_FRONTMATTER_KEY in next &&
    !isCoverValue(next[COVER_FRONTMATTER_KEY])
  ) {
    return next
  }

  const sameRef = cover !== null && next[COVER_FRONTMATTER_KEY] === cover.ref
  const keptFraming = LATER_FRAMING_KEYS.map(({ key, gate }) => {
    const local = next[key]
    return sameRef && gate(local) ? local : undefined
  })

  deleteGated(next, COVER_FRONTMATTER_KEY, isCoverValue)
  deleteGated(next, COVER_FOCUS_FRONTMATTER_KEY, isCoverFocusValue)
  for (const { key, gate } of LATER_FRAMING_KEYS) deleteGated(next, key, gate)
  deleteGated(next, COVER_CREDIT_FRONTMATTER_KEY, isCoverCreditValue)
  deleteGated(next, COVER_CREDIT_URL_FRONTMATTER_KEY, isCoverCreditUrlValue)
  if (cover === null) return next

  next[COVER_FRONTMATTER_KEY] = cover.ref
  if (cover.focus !== undefined && isCoverFocusValue(cover.focus)) {
    next[COVER_FOCUS_FRONTMATTER_KEY] = clampCoverFocus(cover.focus)
  }
  LATER_FRAMING_KEYS.forEach(({ key, field, gate, clamp, fallback }, index) => {
    const remote = cover[field]
    const value = remote !== undefined && gate(remote) ? remote : keptFraming[index]
    if (value === undefined) return
    const clamped = clamp(value)
    if (clamped !== fallback) next[key] = clamped
  })
  if (isCoverCreditValue(cover.credit)) next[COVER_CREDIT_FRONTMATTER_KEY] = cover.credit
  if (isCoverCreditUrlValue(cover.creditUrl)) {
    next[COVER_CREDIT_URL_FRONTMATTER_KEY] = cover.creditUrl
  }
  return next
}

/**
 * Whether this device and the server last agreed the note has a cover, kept in
 * `sync_state` under `note-cover:<noteId>` so it survives a restart.
 *
 * A push has to tell "the user removed the cover here" (send `null`) from "this
 * file never had one" (omit the key). The file alone cannot: both read as no
 * `cover` key. Sending `null` for the second case erases a cover another device
 * set that this one never wrote, so only a note whose cover this device once
 * held pushes a removal.
 *
 * - `present`: the file had a cover when last pushed or applied.
 * - `removal-pending`: a `null` was built for push and has not been confirmed.
 *   A retry rebuilds the payload, so the marker stays until the ack.
 * - `unframed:<ref>`: the file was rebuilt with image cover `ref` alone
 *   (`recordRebuiltNoteCover`). Its framing and credit lived only in the file,
 *   so while the file holds the bare ref the push leaves the cover out, and
 *   peers keep theirs. A build that predates this value reads it as no marker.
 * - `ref-changed:<ref>`: a case twin off its shared file got image cover `ref`
 *   from a local edit (`recordOwnHeaderCoverRef`). Its push sends the ref
 *   alone (`offFileNoteCoverForPush`) until a peer's cover is applied. A build
 *   that predates this value reads it as no marker.
 */
type UnframedMarker = `unframed:${string}`
type RefChangedMarker = `ref-changed:${string}`
type NoteCoverSyncMarker = 'present' | 'removal-pending' | UnframedMarker | RefChangedMarker

const UNFRAMED_MARKER_PREFIX = 'unframed:'
const REF_CHANGED_MARKER_PREFIX = 'ref-changed:'

function isUnframedMarker(value: string): value is UnframedMarker {
  return value.startsWith(UNFRAMED_MARKER_PREFIX)
}

function isRefChangedMarker(value: string): value is RefChangedMarker {
  return value.startsWith(REF_CHANGED_MARKER_PREFIX)
}

function readCoverMarker(db: DrizzleDb, noteId: string): NoteCoverSyncMarker | null {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, COVER_MARKER_KEY_PREFIX + noteId))
    .get()?.value
  if (value === undefined) return null
  return value === 'present' ||
    value === 'removal-pending' ||
    isUnframedMarker(value) ||
    isRefChangedMarker(value)
    ? value
    : null
}

function writeCoverMarker(db: DrizzleDb, noteId: string, marker: NoteCoverSyncMarker | null): void {
  if (readCoverMarker(db, noteId) === marker) return
  const key = COVER_MARKER_KEY_PREFIX + noteId
  if (marker === null) {
    db.delete(syncState).where(eq(syncState.key, key)).run()
    return
  }
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key, value: marker, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value: marker, updatedAt } })
    .run()
}

/**
 * The `cover` a push carries: the frontmatter cover, `null` when a cover this
 * device held was removed, or `undefined` (key omitted) when the note has had
 * no cover here, so peers keep whatever cover they have.
 */
export function noteCoverForPush(
  db: DrizzleDb,
  noteId: string,
  frontmatter: NoteFrontmatter
): NoteCoverSync | null | undefined {
  const cover = noteCoverFromFrontmatter(frontmatter)
  const marker = readCoverMarker(db, noteId)
  if (cover !== null) {
    if (
      marker === `${UNFRAMED_MARKER_PREFIX}${cover.ref}` &&
      isDeepStrictEqual(cover, noteCoverFromFrontmatter({ [COVER_FRONTMATTER_KEY]: cover.ref }))
    ) {
      return undefined
    }
    writeCoverMarker(db, noteId, 'present')
    return cover
  }
  if (marker === null) return undefined
  writeCoverMarker(db, noteId, 'removal-pending')
  return null
}

/**
 * The `cover` a push of a case twin off its shared file carries (`ownHeader`).
 * Its image cover's framing and credit are not held here, so the cover is left
 * out unless its ref changed here, and then it is the ref alone. A removal and
 * any other cover go as for any note (`noteCoverForPush`).
 */
export function offFileNoteCoverForPush(
  db: DrizzleDb,
  noteId: string,
  frontmatter: NoteFrontmatter
): NoteCoverSync | null | undefined {
  const ref = noteCoverFromFrontmatter(frontmatter)?.ref
  if (ref === undefined || parseCoverValue(ref)?.kind !== 'image') {
    return noteCoverForPush(db, noteId, frontmatter)
  }
  return readCoverMarker(db, noteId) === `${REF_CHANGED_MARKER_PREFIX}${ref}`
    ? noteCoverFromFrontmatter({ [COVER_FRONTMATTER_KEY]: ref })
    : undefined
}

/**
 * After a local edit of a case twin off its shared file changed its image
 * cover ref from `before` to `after`: its pushes send the new ref.
 */
export function recordOwnHeaderCoverRef(
  db: DrizzleDb,
  noteId: string,
  before: NoteFrontmatter,
  after: NoteFrontmatter
): void {
  const ref = noteCoverFromFrontmatter(after)?.ref
  if (ref === undefined || ref === noteCoverFromFrontmatter(before)?.ref) return
  if (parseCoverValue(ref)?.kind === 'image') {
    writeCoverMarker(db, noteId, `${REF_CHANGED_MARKER_PREFIX}${ref}`)
  }
}

/**
 * After a confirmed push: a removal that reached the server is done, so later
 * pushes of the coverless note omit the key again. `readFrontmatter` is only
 * called when a removal is pending, which keeps the ack free of a file read
 * for every other note.
 */
export function settleNoteCoverRemoval(
  db: DrizzleDb,
  noteId: string,
  readFrontmatter: () => NoteFrontmatter | null
): void {
  if (readCoverMarker(db, noteId) !== 'removal-pending') return
  const frontmatter = readFrontmatter()
  // A cover added since the null was built is pushed next and sets `present`.
  if (frontmatter !== null && noteCoverFromFrontmatter(frontmatter) === null) {
    writeCoverMarker(db, noteId, null)
  }
}

/** After a remote `cover` was applied: the file now agrees with the server. */
export function recordAppliedNoteCover(
  db: DrizzleDb,
  noteId: string,
  frontmatter: NoteFrontmatter
): void {
  writeCoverMarker(db, noteId, noteCoverFromFrontmatter(frontmatter) !== null ? 'present' : null)
}

/**
 * After the note's file was rebuilt from its index rows, which hold the cover
 * ref (`case-twin-file.ts`). An image cover's framing and credit were not
 * written, so its push waits for a change here; any other cover was written
 * whole, and no cover sends no removal. A removal built for push and not yet
 * acked stays pending: its retry still sends the `null`.
 */
export function recordRebuiltNoteCover(db: DrizzleDb, noteId: string, ref: string | null): void {
  if (ref !== null && parseCoverValue(ref)?.kind === 'image') {
    writeCoverMarker(db, noteId, `${UNFRAMED_MARKER_PREFIX}${ref}`)
  } else if (readCoverMarker(db, noteId) !== 'removal-pending') {
    writeCoverMarker(db, noteId, null)
  }
}

export function clearNoteCoverMarker(db: DrizzleDb, noteId: string): void {
  writeCoverMarker(db, noteId, null)
}
