import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseNote } from '../../src/main/vault/frontmatter'
import { WRITING_DRAFTS_NOTE } from '../seed-data/writing-drafts'
import { buildWritingDraftsDoc, checkWritingDraftsDoc } from '../seed-data/writing-drafts-doc'
import { writeCrdtDocs } from './crdt-writer'

/**
 * Build the writing tools demo note's doc from the file already written into
 * the vault, through the same parse and converter the app's first open uses,
 * and store it in `storeDir` under `noteId`.
 *
 * `noteId` comes from the caller: this module gets its own instance of
 * seed-data/notes.ts, whose ids are random per evaluation, so its
 * `NOTE_IDS.writingDrafts` is not the id the seed wrote into data.db.
 *
 * seed-vault.ts loads this module through Vite's module runner instead of
 * importing it. The seed runs as CommonJS under tsx, where `@blocknote/core`
 * resolves to its CJS build, and that build throws on load
 * (`te.default.extend is not a function`). The app bundles BlockNote's ESM
 * build, and vitest loads it the same way the runner does, so this is the
 * converter the app runs. Everything Yjs-related stays on this side of the
 * runner so the seed never holds two copies of Yjs.
 */
export async function storeWritingDraftsDoc(
  vaultPath: string,
  noteId: string,
  storeDir: string
): Promise<void> {
  const notePath = WRITING_DRAFTS_NOTE.relativePath
  const raw = readFileSync(resolve(vaultPath, notePath), 'utf8')
  const doc = await buildWritingDraftsDoc(noteId, parseNote(raw, notePath).content, notePath)
  try {
    await writeCrdtDocs(storeDir, [{ noteId, doc, check: checkWritingDraftsDoc }])
  } finally {
    doc.destroy()
  }
}
