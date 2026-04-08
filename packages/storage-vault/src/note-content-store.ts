import fs from 'fs/promises'
import path from 'path'

export interface VaultStoreLayout {
  rootPath: string
  notesFolder: string
  journalFolder: string
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
      const tempPath = `${absolutePath}.tmp`
      await fs.writeFile(tempPath, content, 'utf-8')
      await fs.rename(tempPath, absolutePath)
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
      return normalizeRelativePath(path.join(layout.journalFolder, `${date}.md`))
    }
  }
}
