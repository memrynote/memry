import type { ImportContext, ImportInput, ImportSummary, Importer } from '../types'

/**
 * Readwise is an account-based importer (#1408 D1): the Settings → Import row
 * and panel exist here, and the backfill is the first run of the sync engine.
 * `run` stays closed until #1413 puts the engine in the build, and the panel
 * keeps Import now disabled while `ReadwiseStatusResult.runAvailable` is false.
 */
export const readwiseImporter: Importer = {
  id: 'readwise',
  name: 'Readwise',
  descriptionKey: 'import.sources.readwise',
  accountBased: true,
  fileSpec: {
    label: 'Readwise',
    extensions: [],
    allowMultiple: false
  },

  run(_input: ImportInput, _ctx: ImportContext): Promise<ImportSummary> {
    return Promise.reject(new Error('The Readwise import is not available in this build yet'))
  }
}
