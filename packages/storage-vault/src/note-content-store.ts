import fs from 'fs/promises'
import path from 'path'
import { randomBytes } from 'node:crypto'
import { formatJournalFilename } from './journal-format.ts'

export interface VaultStoreLayout {
  rootPath: string
  notesFolder: string
  journalFolder: string
  /** Obsidian-style date format for journal filenames; defaults to YYYY-MM-DD */
  journalDateFormat?: string
}

export interface NoteContentStore {
  resolve(relativePath: string): string
  read(relativePath: string): Promise<string | null>
  write(relativePath: string, content: string): Promise<void>
  remove(relativePath: string): Promise<boolean>
  exists(relativePath: string): Promise<boolean>
  getJournalRelativePath(date: string): string
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

export function createNoteContentStore(layout: VaultStoreLayout): NoteContentStore {
  const resolve = (relativePath: string) => path.join(layout.rootPath, relativePath)

  return {
    resolve,
    async read(relativePath) {
      try {
        return await fs.readFile(resolve(relativePath), 'utf-8')
      } catch {
        return null
      }
    },
    async write(relativePath, content) {
      const absolutePath = resolve(relativePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      const tempPath = path.join(
        path.dirname(absolutePath),
        `.${path.basename(absolutePath)}.${randomBytes(6).toString('hex')}.tmp`
      )
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null

      try {
        handle = await fs.open(tempPath, 'wx', 0o600)
        await handle.writeFile(content, 'utf-8')
        await handle.close()
        handle = null
        await fs.rename(tempPath, absolutePath)
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {})
        }
        await fs.rm(tempPath, { force: true }).catch(() => {})
        throw error
      }
    },
    async remove(relativePath) {
      try {
        await fs.unlink(resolve(relativePath))
        return true
      } catch {
        return false
      }
    },
    async exists(relativePath) {
      try {
        await fs.access(resolve(relativePath))
        return true
      } catch {
        return false
      }
    },
    getJournalRelativePath(date) {
      const filename = formatJournalFilename(date, layout.journalDateFormat ?? '')
      return normalizeRelativePath(path.join(layout.journalFolder, `${filename}.md`))
    }
  }
}
