/**
 * Renaming or moving a case twin (#5263) without moving the file it shares.
 *
 * Two rows whose paths differ only in case name one file on a case-insensitive
 * disk, and the file holds one twin's body. A rename that moved that file left
 * the other twin's row with no file (#5498). Instead, the twin that moves
 * writes its own body, from its doc, to its new path, and the shared file
 * stays with the other twin. This also splits the pair into two files.
 *
 * @module vault/case-twin-split
 */

import { foldNotePath } from '@memry/storage-data'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { getDatabase, getIndexDatabase } from '../database'
import { getCrdtProvider } from '../sync/crdt-provider'
import { owesFileBody } from '../sync/crdt-owed-file-body'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import { mergeFrontmatter } from '../sync/crdt-writeback-frontmatter'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { writeWithBaseline } from '../sync/writeback-baseline'
import { serializeNote } from './frontmatter'
import { atomicWrite } from './file-ops'
import { getVaultRoot, toAbsolutePath } from './notes-io'
import { sharesCaseTwinFile } from './note-sync'

/**
 * Write note `id`'s own body, from its doc, to `newRelativePath`, a path no
 * file holds yet, and make those bytes its baseline. Throws when this device
 * holds no body for it to write: an empty doc, a doc that owes its file
 * (the file it owes is the shared one), or a doc this build cannot serialize.
 * The shared file is never read.
 */
export async function writeCaseTwinBody(id: string, newRelativePath: string): Promise<void> {
  const provider = getCrdtProvider()
  const release = provider.holdDoc(id)
  try {
    const doc = await provider.open(id, undefined, { skipSeed: true })
    const conversion =
      owesFileBody(id) || doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0
        ? null
        : await (
            await readyWritebackConverter()
          )(doc, newRelativePath, async () => null)
    if (conversion?.kind !== 'serialized' || conversion.body === null) {
      throw new Error('errors:note.caseTwinNoBody')
    }
    const { markdown, writing } = conversion.body
    const content = serializeNote(mergeFrontmatter(null, doc, writing).frontmatter, markdown)
    const absolutePath = toAbsolutePath(newRelativePath)
    markWritebackIgnored(absolutePath)
    await writeWithBaseline(getIndexDatabase(), id, content, () =>
      atomicWrite(absolutePath, content)
    )
  } finally {
    await release()
  }
}

/**
 * Refuse a folder rename that would strand a case twin. The rename carries
 * the rows spelled with the folder's exact name. A twin spelled with the
 * folder in another case keeps a path with no file, and carrying it would
 * put both twins on one path.
 */
export function assertFolderRenameKeepsCaseTwins(folderPath: string): void {
  const exact = `${folderPath}/`
  const folded = foldNotePath(exact)
  const stranded = getDatabase()
    .select({ path: noteMetadata.path })
    .from(noteMetadata)
    .all()
    .some(
      ({ path }) =>
        !path.startsWith(exact) &&
        foldNotePath(path).startsWith(folded) &&
        sharesCaseTwinFile(getVaultRoot(), path)
    )
  if (stranded) throw new Error('errors:folder.renameCaseTwins')
}
