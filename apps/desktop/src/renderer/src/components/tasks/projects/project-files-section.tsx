import { useCallback, useEffect, useState } from 'react'
import { File, FileText, Image, Music, Video, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ProjectFiles')

type FileKind = 'pdf' | 'image' | 'audio' | 'video'

interface LinkedFile {
  itemId: string
  title: string
  fileType: FileKind
}

const FILE_ICONS = {
  pdf: FileText,
  image: Image,
  audio: Music,
  video: Video
} as const

interface ProjectFilesSectionProps {
  projectId: string
  onFileClick?: (fileId: string) => void
  className?: string
}

/**
 * Project Home "Files" section — lists the files (notes with a non-markdown
 * fileType) linked to a project via `project_links` and lets the user unlink
 * one. Files are resolved through `notesService.getFile`, which returns null
 * for a deleted file or a markdown note, so orphaned links are skipped.
 */
export const ProjectFilesSection = ({
  projectId,
  onFileClick,
  className
}: ProjectFilesSectionProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const [files, setFiles] = useState<LinkedFile[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadFiles = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const links = await tasksService.listProjectLinks(projectId)
      const fileLinks = links.filter((link) => link.itemType === 'file')
      const resolved = await Promise.all(
        fileLinks.map(async (link) => {
          // Defensive: getFile returns null for a deleted file (orphaned link)
          // or a markdown id; skip either. Cleanup of orphaned links is owned
          // by a concurrent effort.
          const file = await notesService.getFile(link.itemId)
          if (!file) return null
          return { itemId: link.itemId, title: file.title, fileType: file.fileType }
        })
      )
      setFiles(resolved.filter((file): file is LinkedFile => file !== null))
    } catch (error) {
      log.error(
        'Failed to load project files',
        extractErrorMessage(error, t('projectFiles.loadError'))
      )
    } finally {
      setIsLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const handleRemove = useCallback(
    async (itemId: string): Promise<void> => {
      try {
        await tasksService.unlinkProjectItem({ projectId, itemType: 'file', itemId })
        setFiles((prev) => prev.filter((file) => file.itemId !== itemId))
      } catch (error) {
        log.error(
          'Failed to remove file from project',
          extractErrorMessage(error, t('projectFiles.removeError'))
        )
      }
    },
    [projectId, t]
  )

  if (!isLoading && files.length === 0) return null

  return (
    <section className={cn('px-4 py-3 border-t border-border', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectFiles.title')}
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('projectFiles.loading')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {files.map((file) => {
            const Icon = FILE_ICONS[file.fileType] ?? File
            return (
              <div
                key={file.itemId}
                className="group relative flex items-center gap-2 rounded-md border border-border p-2 hover:bg-surface-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-start"
                  onClick={() => onFileClick?.(file.itemId)}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-sm">{file.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('projectFiles.removeFromProject')}
                  onClick={() => void handleRemove(file.itemId)}
                  className="shrink-0 rounded-sm p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default ProjectFilesSection
