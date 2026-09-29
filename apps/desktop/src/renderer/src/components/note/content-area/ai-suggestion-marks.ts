import type { Extension, ExtensionFactoryInstance } from '@blocknote/core'
import { AIExtension } from '@blocknote/xl-ai'

/** Key xl-ai gives the extension that carries its `insertion`/`deletion`/`modification` marks. */
const AI_SUGGESTION_MARKS_KEY = 'aiAttributionMarks'

/**
 * The marks the AI writes its suggestions with, registered at editor creation.
 *
 * `AIExtension` is registered after the editor exists (`useBlockNoteSetup`),
 * because the AI server port arrives later and the user can toggle AI off. It
 * brings these marks along as a tiptap extension, but BlockNote cannot add
 * tiptap extensions to a live editor: `registerExtension` only warns ("these
 * cannot be changed after initializing the editor") and the schema stays
 * without them. Every AI edit then failed at the first `schema.mark('insertion')`,
 * and the menu's Reject/Cancel threw "Failed to find insertion mark in schema"
 * from `revertSuggestions` (#2527).
 *
 * Taken from `AIExtension` itself rather than redeclared, so the marks stay
 * exactly the ones xl-ai writes. The later `AIExtension` registration finds
 * this key already present and skips it; unregistering `ai` leaves it in place.
 */
export const aiSuggestionMarksExtension: ExtensionFactoryInstance = (ctx) => {
  const aiExtension = AIExtension()(ctx)
  const marks = (aiExtension.blockNoteExtensions ?? [])
    .map((factory): Extension => factory(ctx))
    .find((extension) => extension.key === AI_SUGGESTION_MARKS_KEY)
  return marks ?? { key: AI_SUGGESTION_MARKS_KEY }
}
