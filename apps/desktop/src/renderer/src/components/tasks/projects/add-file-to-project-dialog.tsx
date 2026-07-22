import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { tasksService, type ProjectWithStats } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('AddToProject')

interface AddFileToProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileId: string
}

/**
 * File info bar → "Add to project": lists active projects and links the file
 * to the chosen one via `PROJECT_LINK_ITEM` (itemType 'file').
 */
export const AddFileToProjectDialog = ({
  open,
  onOpenChange,
  fileId
}: AddFileToProjectDialogProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setIsLoading(true)
    tasksService
      .listProjects()
      .then((res) => setProjects(res.projects.filter((project) => project.archivedAt == null)))
      .catch((error) => log.error('Failed to list projects', extractErrorMessage(error)))
      .finally(() => setIsLoading(false))
  }, [open])

  const handleSelect = async (project: ProjectWithStats): Promise<void> => {
    try {
      const result = await tasksService.linkProjectItem({
        projectId: project.id,
        itemType: 'file',
        itemId: fileId
      })
      if (!result.success) throw new Error(result.error)
      toast.success(t('addToProject.toastSuccess', { name: project.name }))
      onOpenChange(false)
    } catch (error) {
      toast.error(extractErrorMessage(error, t('addToProject.toastError')))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addToProject.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[300px] -mx-2">
          <div className="space-y-1 px-2">
            {isLoading ? (
              <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
                {t('addToProject.loading')}
              </div>
            ) : projects.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
                {t('addToProject.noProjects')}
              </div>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => void handleSelect(project)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md p-2 text-start transition-colors',
                    'hover:bg-muted/50'
                  )}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-sm">{project.name}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

export default AddFileToProjectDialog
