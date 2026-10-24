/**
 * Did this DOM event start inside a whiteboard block?
 *
 * A whiteboard hosts a live Excalidraw surface inside the note's DOM, so every
 * key, paste and click it handles also passes the note editor's own listeners
 * on the way. ProseMirror is kept out by the block's node view, but the note's
 * plain DOM listeners are not — and several of them act on the note's caret,
 * which sits wherever it was before the board took focus: a URL pasted onto
 * the board would offer to become a bookmark in the note, a link clicked in the
 * board opened twice. Excalidraw's own paste, copy and keyup listeners are on
 * `document`, so the board cannot simply stop these events at its edge; each
 * note listener asks this instead.
 *
 * Standalone, with no imports, so those listeners can ask without loading the
 * block module.
 */
export function isFromWhiteboard(event: Event): boolean {
  const target = event.target
  return target instanceof Element && target.closest('[data-content-type="whiteboard"]') !== null
}
