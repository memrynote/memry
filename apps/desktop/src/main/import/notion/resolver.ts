import path from 'node:path'

export interface NotionFileInfo {
  title: string
  parentIds: string[]
  path: string
  ctime: Date | null
  mtime: Date | null
  fullLinkPathNeeded?: boolean
}

export interface NotionAttachmentInfo {
  path: string
  parentIds: string[]
  nameWithExtension: string
  targetParentFolder: string
  fullLinkPathNeeded?: boolean
}

const ID_SUFFIX = /\s+[a-z0-9]{32}$/
const TRAILING_DOT_SPACE = /[. ]+$/

/**
 * Holds the page tree discovered while scanning a Notion export and resolves
 * each page/attachment to a folder under the import root.
 *
 * Ported from obsidian-importer's `NotionResolverInfo`, adapted to be FS-free:
 * Memry's `createNote`/`saveAttachment` already generate unique paths, so the
 * de-duplication here only needs to settle in-export title collisions.
 */
export class NotionResolverInfo {
  idsToFileInfo: Record<string, NotionFileInfo> = {}
  pathsToAttachmentInfo: Record<string, NotionAttachmentInfo> = {}

  /** Folder (relative to the import root, trailing `/`) a page/attachment lands in. */
  getPathForFile(fileInfo: NotionFileInfo | NotionAttachmentInfo): string {
    const { idsToFileInfo } = this
    const pathNames = fileInfo.path.split('/')

    if (fileInfo.parentIds.length > 0) {
      const mappedPathParts = fileInfo.parentIds
        .map(
          (parentId) =>
            idsToFileInfo[parentId]?.title ??
            pathNames.find((seg) => seg.includes(parentId))?.replace(` ${parentId}`, '')
        )
        // Inline databases have no .html file, so they drop out of the tree.
        .filter((part): part is string => Boolean(part))
        // Folder names can't end in a dot or a space.
        .map((folder) => folder.replace(TRAILING_DOT_SPACE, ''))

      if (mappedPathParts.length > 0) {
        return mappedPathParts.join('/') + '/'
      }
    }

    // No usable parent ids: fall back to the on-disk folder structure, stripping ids.
    const parent = path.posix.dirname(fileInfo.path)
    if (parent === '.' || parent === '') return ''

    const folderPath = parent
      .split('/')
      .filter((seg) => seg.length > 0)
      .map((segment) => segment.replace(ID_SUFFIX, '').trim())
      .filter((seg) => seg.length > 0)
      .map((folder) => folder.replace(TRAILING_DOT_SPACE, ''))
      .join('/')

    return folderPath ? folderPath + '/' : ''
  }

  /**
   * Settle in-export collisions: pages sharing a folder + title get a numeric
   * suffix, and attachments get their resolved target folder. FS-free.
   */
  cleanDuplicates(targetFolderPath: string): void {
    const pathDuplicateChecks = new Set<string>()
    const titleDuplicateChecks = new Set<string>()

    for (const fileInfo of Object.values(this.idsToFileInfo)) {
      const folder = this.getPathForFile(fileInfo)

      if (pathDuplicateChecks.has(`${folder}${fileInfo.title}`)) {
        let index = 2
        fileInfo.title = `${fileInfo.title} ${index}`
        while (pathDuplicateChecks.has(`${folder}${fileInfo.title}`)) {
          index++
          fileInfo.title = `${fileInfo.title.replace(/ \d+$/, '')} ${index}`
        }
      }

      if (titleDuplicateChecks.has(fileInfo.title)) {
        fileInfo.fullLinkPathNeeded = true
      }

      pathDuplicateChecks.add(`${folder}${fileInfo.title}`)
      titleDuplicateChecks.add(fileInfo.title)
    }

    for (const attachmentInfo of Object.values(this.pathsToAttachmentInfo)) {
      attachmentInfo.targetParentFolder = `${targetFolderPath}${this.getPathForFile(attachmentInfo)}`
    }
  }
}
