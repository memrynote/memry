import fs from 'fs/promises'

import { getExtension, getFileType } from '@memry/shared/file-types'
import { markAddedChecklistLinesPlain } from '../import/_shared/checklist-tasks'

/**
 * Copies a file into the vault for `importFiles`. With `plainChecklists`, a
 * markdown file's checkbox lines are written with the plain marker instead.
 * A file whose bytes are not UTF-8 would not survive that rewrite, so it is
 * copied as it is.
 */
export async function copyImportedFile(
  sourcePath: string,
  destPath: string,
  plainChecklists: boolean
): Promise<void> {
  if (plainChecklists && getFileType(getExtension(sourcePath)) === 'markdown') {
    const bytes = await fs.readFile(sourcePath)
    const text = bytes.toString('utf8')
    const marked = markAddedChecklistLinesPlain(text)
    if (marked !== text && Buffer.from(text, 'utf8').equals(bytes)) {
      await fs.writeFile(destPath, marked)
      return
    }
  }
  await fs.copyFile(sourcePath, destPath)
}
