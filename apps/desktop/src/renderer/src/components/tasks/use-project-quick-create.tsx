import { useCallback, useState } from 'react'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Picker, usePickerContext } from '@/components/ui/picker'
import { ProjectModal } from '@/components/tasks/project-modal'
import { useTasksOptional } from '@/contexts/tasks'
import { useT } from '@memry/i18n/renderer'
import type { Project } from '@/data/tasks-data'

interface ProjectQuickCreate {
  canCreate: boolean
  openCreate: () => void
  dialog: React.ReactNode
}

export function useProjectQuickCreate(onCreated: (projectId: string) => void): ProjectQuickCreate {
  const tasks = useTasksOptional()
  const [isOpen, setIsOpen] = useState(false)

  const openCreate = useCallback(() => setIsOpen(true), [])

  const handleSave = useCallback(
    async (project: Project): Promise<void> => {
      // addProject rejects when the create failed (envelope or IPC); the
      // failure is already logged + tracked in the mutation layer. Returning
      // here is what stops onCreated from selecting a phantom project id.
      try {
        await tasks?.addProject(project)
      } catch {
        return
      }
      onCreated(project.id)
    },
    [tasks, onCreated]
  )

  const dialog = tasks ? (
    // Modal closes immediately after onSave; handleSave contains the rejection.
    <ProjectModal
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      onSave={(p) => void handleSave(p)}
    />
  ) : null

  return { canCreate: !!tasks, openCreate, dialog }
}

export function ProjectCreateFooter({ onStart }: { onStart: () => void }): React.JSX.Element {
  const { t: tTasks } = useT('tasks')
  const { onOpenChange } = usePickerContext()

  return (
    <Picker.Footer className="p-1">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-[5px] py-1.5 px-2 text-muted-foreground transition-colors',
          'hover:bg-accent focus:outline-none'
        )}
        onClick={() => {
          onOpenChange(false)
          onStart()
        }}
      >
        <Plus className="size-4 shrink-0" />
        {tTasks('phaseF.componentsTasksProjectsProjectSelector.createProject')}
      </button>
    </Picker.Footer>
  )
}
