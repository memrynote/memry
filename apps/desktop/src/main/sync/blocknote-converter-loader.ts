import type * as BlockNoteConverter from './blocknote-converter'

let converterLoad: Promise<typeof BlockNoteConverter> | null = null

/**
 * The markdown <-> Y.Doc converter, loaded on first use.
 *
 * Lazy on purpose: blocknote-converter.ts builds the BlockNote server schema at
 * module load and pulls in @blocknote/core, @blocknote/server-util and jsdom.
 * A static import put all of that in the main process startup set, although a
 * launch that opens no unseeded note and writes nothing back never converts.
 * Every caller shares one load promise, so concurrent first conversions load
 * the module once. `scripts/check-main-startup-set.mjs` keeps it off the
 * startup path.
 */
export function loadBlockNoteConverter(): Promise<typeof BlockNoteConverter> {
  if (!converterLoad) {
    converterLoad = import('./blocknote-converter').catch((error: unknown) => {
      // A failed load is not cached, so the next conversion retries it.
      converterLoad = null
      throw error
    })
  }
  return converterLoad
}
