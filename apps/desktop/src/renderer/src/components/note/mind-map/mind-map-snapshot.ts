/**
 * The map, turned into a canvas the user owns.
 *
 * Pure, and deliberately free of the drawing library: everything here is plain
 * data, so the whole shape of a saved canvas — its links, its dated root, its
 * document envelope, its name — is asserted in a unit test with no DOM. The one
 * step that needs the library (skeletons → real elements) lives in the lazy
 * chunk, in `mind-map-export.ts`.
 *
 * The promise the whole feature rests on: the moment the canvas exists it
 * DETACHES. Nothing regenerates it, nothing overwrites it, and the note holds
 * no reference back to it. That is why saving twice makes a second canvas
 * rather than replacing the first — the first may be an hour of someone's work
 * by then — and it is why the relationship is one-way: the reverse would need a
 * database field, a sync handler and a compatibility plan it does not earn.
 *
 * Three things the snapshot changes about the map as drawn, all for the same
 * reason — the file outlives the document that produced it:
 *
 * 1. **Links anchor on heading TEXT, never on a block id.** Block ids are
 *    minted at parse time and markdown does not carry them, so a copied vault,
 *    a fresh device or a rebuilt document mints new ones. A list node anchors
 *    to its nearest ancestor heading; a node under no heading anchors on
 *    nothing and opens the note at the top.
 * 2. **The root carries the date it was generated**, so a canvas found months
 *    later announces that it is a snapshot rather than a live view.
 * 3. **Nodes stay plain shapes carrying deep links, never live entity cards.**
 *    A card is roughly ten times the size of a map node and a dozen of them
 *    make the map unreadable. The user can add real cards by hand — it is their
 *    canvas.
 *
 * Two node kinds need saying out loud, because neither is a place in this note:
 *
 * - A **wiki-link** node points at another document. On screen its href is only
 *   a click handle and the real destination is `wikiTarget`, a title — but a
 *   saved file has no click handler to read that, so the caller resolves the
 *   target through the same resolver a `[[…]]` in the body goes through and
 *   hands the answers in as `wikiHrefs`. A target that resolves to nothing
 *   falls back to the heading anchor every other node gets: the box then opens
 *   the note at the section the link is written in, which is the only true
 *   thing left to say about it.
 * - A **"+N more"** fold marker is a view affordance with nothing to expand in
 *   a file. It is still minted, and deliberately: it is the line that says how
 *   much of the note is not on this canvas, and dropping it would be exactly
 *   the silent loss the whole feature refuses. It anchors on the heading whose
 *   children are folded, so clicking it opens the note at the place the missing
 *   rows actually live.
 */

import { mintElements } from './mind-map-elements'
import type { MindMap, MindMapElement } from './mind-map-types'

export interface MindMapSnapshotOptions {
  /** The note the links point back at. */
  noteId: string
  /**
   * The dated badge on the root box, ahead of whatever the root already says.
   * Translated and formatted by the caller: this module has no translator and
   * must not grow one, and the text is frozen into the file the moment it is
   * written.
   */
  generatedLabel: string
  /**
   * Wiki-link node id → the href its box should carry, resolved by the caller.
   * Absent entries fall back to a heading anchor into the source note. See the
   * module note above.
   */
  wikiHrefs?: ReadonlyMap<string, string>
}

/**
 * The map as currently drawn, re-minted for a file rather than for a session.
 *
 * Same nodes, same coordinates — this is the map the user is looking at, not a
 * second projection of the note — with durable links and a dated root.
 */
export function mintSnapshotElements(
  map: MindMap,
  { noteId, generatedLabel, wikiHrefs }: MindMapSnapshotOptions
): MindMapElement[] {
  return mintElements(map.nodes, map.direction, {
    noteId,
    anchor: 'heading',
    rootDetail: generatedLabel,
    wikiHrefs
  })
}

/**
 * The canvas document, as the vault stores one.
 *
 * The keys and their order are `canvas/scene-file.ts`'s own (`EMPTY_SCENE`,
 * written back out by `canonicalize`), so the store canonicalizes this to
 * itself plus its `memry` sidecar and writes it unchanged. `appState` is left
 * empty on purpose: the camera is the reader's, and a canvas that opens where
 * the map happened to be scrolled would be a surprise rather than a courtesy.
 */
export function mindMapSceneJson(elements: readonly unknown[]): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'memry',
    elements,
    appState: {},
    files: {}
  })
}

/** How the vault compares two names: NFC-folded and case-insensitive. */
function titleKey(title: string): string {
  return title.normalize('NFC').toLowerCase()
}

/**
 * `Plan`, then `Plan 2`, then `Plan 3` — the same suffix the vault gives a
 * canvas FILE whose name is already taken (`allocateCanvasPath`), applied to
 * the stored title as well.
 *
 * Both halves are needed or they disagree: the file is uniquified on disk
 * whatever we ask for, so a row left holding the raw title would show two
 * identically-named canvases in the sidebar pointing at differently-named
 * files. `duplicateCanvas` solves the same problem the same way, one layer
 * down.
 */
export function uniqueCanvasTitle(title: string, taken: Iterable<string | null>): string {
  const claimed = new Set<string>()
  for (const name of taken) {
    if (name !== null && name !== '') claimed.add(titleKey(name))
  }

  if (!claimed.has(titleKey(title))) return title

  let counter = 2
  while (claimed.has(titleKey(`${title} ${counter}`))) counter += 1
  return `${title} ${counter}`
}
