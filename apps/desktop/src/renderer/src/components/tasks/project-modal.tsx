import { lazy, Suspense, useState, useCallback, useMemo } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { ColorPicker } from '@/components/tasks/color-picker'
import { StatusEditor } from '@/components/tasks/status-editor'
import { DeleteProjectDialog } from '@/components/tasks/delete-project-dialog'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import {
  type Project,
  type Status,
  createDefaultProject,
  generateId,
  validateProject,
  type ProjectValidationErrors
} from '@/data/tasks-data'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

// Mirrors createDefaultProject().icon: used to detect a custom icon (show Remove)
// and to reset the icon when the user removes it.
const DEFAULT_ICON = 'Folder'

// ============================================================================
// TYPES
// ============================================================================

interface ProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (project: Project) => void
  onDelete?: (projectId: string) => void
  project?: Project | null // null/undefined = create mode, Project = edit mode
}

interface FormData {
  name: string
  description: string
  icon: string
  color: string
  statuses: Status[]
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const getInitialFormData = (project?: Project | null): FormData => {
  if (project) {
    return {
      name: project.name,
      description: project.description,
      icon: project.icon,
      color: project.color,
      statuses: [...project.statuses]
    }
  }

  const defaults = createDefaultProject()
  return {
    name: defaults.name,
    description: defaults.description,
    icon: defaults.icon,
    color: defaults.color,
    statuses: defaults.statuses
  }
}

const hasFormChanged = (original: FormData, current: FormData): boolean => {
  if (original.name !== current.name) return true
  if (original.description !== current.description) return true
  if (original.icon !== current.icon) return true
  if (original.color !== current.color) return true
  if (original.statuses.length !== current.statuses.length) return true

  // Deep compare statuses
  for (let i = 0; i < original.statuses.length; i++) {
    const orig = original.statuses[i]
    const curr = current.statuses[i]
    if (
      orig.id !== curr.id ||
      orig.name !== curr.name ||
      orig.color !== curr.color ||
      orig.type !== curr.type ||
      orig.order !== curr.order
    ) {
      return true
    }
  }

  return false
}

const getProjectDialogKey = (isOpen: boolean, project?: Project | null): string => {
  if (!isOpen) return 'closed'
  if (!project) return 'new'

  return JSON.stringify({
    id: project.id,
    name: project.name,
    description: project.description,
    icon: project.icon,
    color: project.color,
    statuses: project.statuses
  })
}

// ============================================================================
// PROJECT MODAL COMPONENT
// ============================================================================

const ProjectModalDialog = ({
  isOpen,
  onClose,
  onSave,
  onDelete,
  project
}: ProjectModalProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  const isEditMode = !!project
  const canDelete = isEditMode && !project.isDefault
  const initialFormData = useMemo(() => getInitialFormData(project), [project])

  // Form state
  const [formData, setFormData] = useState<FormData>(() => initialFormData)

  // Icon picker state (a modal Popover hosting the shared emoji/icon picker)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)

  // Unsaved changes dialog
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  // Check for unsaved changes
  const hasUnsavedChanges = useMemo(
    () => hasFormChanged(initialFormData, formData),
    [initialFormData, formData]
  )

  const errors = useMemo<ProjectValidationErrors>(
    () => validateProject(formData.name, formData.statuses),
    [formData.name, formData.statuses]
  )

  const isValid = Object.keys(errors).length === 0

  // Handlers
  const handleClose = useCallback((): void => {
    if (hasUnsavedChanges) {
      setShowUnsavedDialog(true)
    } else {
      onClose()
    }
  }, [hasUnsavedChanges, onClose])

  const handleDiscardChanges = (): void => {
    setShowUnsavedDialog(false)
    onClose()
  }

  const handleCancelDiscard = (): void => {
    setShowUnsavedDialog(false)
  }

  const handleSave = (): void => {
    if (!isValid) return

    const savedProject: Project = isEditMode
      ? {
          ...project,
          name: formData.name,
          description: formData.description,
          icon: formData.icon,
          color: formData.color,
          statuses: formData.statuses
        }
      : {
          id: generateId('project'),
          name: formData.name,
          description: formData.description,
          icon: formData.icon,
          color: formData.color,
          statuses: formData.statuses,
          isDefault: false,
          isArchived: false,
          createdAt: new Date(),
          taskCount: 0
        }

    onSave(savedProject)
    onClose()
  }

  const handleDelete = (): void => {
    setShowDeleteDialog(true)
  }

  const handleConfirmDelete = (): void => {
    if (onDelete && project) {
      onDelete(project.id)
    }
    // Close like handleSave does. Call sites only run the mutation + toast;
    // without this the modal stayed open on top of the "Project deleted" toast,
    // still editing a project that no longer exists.
    onClose()
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setFormData((prev) => ({ ...prev, name: e.target.value }))
  }

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setFormData((prev) => ({ ...prev, description: e.target.value }))
  }

  const handleColorChange = (color: string): void => {
    setFormData((prev) => ({ ...prev, color }))
  }

  const handleIconSelect = (icon: string): void => {
    setFormData((prev) => ({ ...prev, icon }))
  }

  const handleIconRemove = (): void => {
    setFormData((prev) => ({ ...prev, icon: DEFAULT_ICON }))
  }

  const handleStatusesChange = (statuses: Status[]): void => {
    setFormData((prev) => ({ ...prev, statuses }))
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditMode ? 'Edit Project' : 'Create Project'}</DialogTitle>
            <DialogDescription className="sr-only">
              {isEditMode
                ? 'Edit the project name, icon, color, and workflow statuses.'
                : 'Create a new project with a name, icon, color, and workflow statuses.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Icon & Name Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {tPhaseF('phaseF.componentsTasksProjectModal.iconName')}
              </label>
              <div className="flex items-center gap-3">
                {/* Icon Button — hosts the shared emoji/icon picker in a modal Popover.
                    A modal Popover is a branch of the Dialog's dismissable layer, so it
                    owns anchoring, focus, and dismissal while the Dialog stays modal —
                    no modal toggling, no flicker, and the first click reliably registers. */}
                <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen} modal>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex size-12 shrink-0 items-center justify-center rounded-sm border-2 border-dashed',
                        'transition-colors hover:border-primary hover:bg-accent/50',
                        'focus-visible:outline-none'
                      )}
                      aria-label={tPhaseF('phaseF.componentsTasksProjectModal.selectIcon')}
                    >
                      <ProjectIcon
                        icon={formData.icon}
                        className="size-6 text-text-secondary"
                        fallback={<span className="text-2xl">📁</span>}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    sideOffset={8}
                    className="w-auto border-0 bg-transparent p-0 shadow-none"
                  >
                    <Suspense fallback={null}>
                      <LazyEmojiPicker
                        isOpen
                        embedded
                        hasEmoji={formData.icon !== DEFAULT_ICON}
                        onClose={() => setIconPickerOpen(false)}
                        onSelect={handleIconSelect}
                        onRemove={handleIconRemove}
                      />
                    </Suspense>
                  </PopoverContent>
                </Popover>

                {/* Name Input */}
                <div className="flex-1">
                  <Input
                    type="text"
                    value={formData.name}
                    onChange={handleNameChange}
                    placeholder={tPhaseF('phaseF.componentsTasksProjectModal.projectName')}
                    maxLength={50}
                    className={cn(errors.name && 'border-destructive')}
                    autoFocus
                  />
                  {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
                </div>
              </div>
              <p className="text-xs text-text-tertiary">
                {tPhaseF('phaseF.componentsTasksProjectModal.clickIconToChange')}
              </p>
            </div>

            <Separator />

            {/* Color Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {tPhaseF('phaseF.componentsTasksProjectModal.color')}
              </label>
              <ColorPicker value={formData.color} onChange={handleColorChange} />
            </div>

            <Separator />

            {/* Description Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {tPhaseF('phaseF.componentsTasksProjectModal.descriptionOptional')}
              </label>
              <textarea
                value={formData.description}
                onChange={handleDescriptionChange}
                aria-label={tPhaseF('phaseF.componentsTasksProjectModal.descriptionOptional')}
                placeholder={tPhaseF(
                  'phaseF.componentsTasksProjectModal.briefDescriptionOfThisProject'
                )}
                rows={2}
                maxLength={200}
                className={cn(
                  'w-full resize-none rounded-sm border bg-transparent px-3 py-2 text-sm',
                  'placeholder:text-muted-foreground',
                  'focus-visible:outline-none'
                )}
              />
            </div>

            <Separator />

            {/* Statuses Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {tPhaseF('phaseF.componentsTasksProjectModal.statuses')}
              </label>
              <p className="text-xs text-text-tertiary">
                {tPhaseF(
                  'phaseF.componentsTasksProjectModal.configureTheWorkflowStagesForThisProject'
                )}
              </p>
              <StatusEditor
                statuses={formData.statuses}
                onChange={handleStatusesChange}
                error={errors.statuses}
              />
            </div>
          </div>

          <DialogFooter className="flex-row justify-between sm:justify-between">
            {/* Delete button (left side, edit mode only) */}
            <div>
              {canDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDelete}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {tPhaseF('phaseF.componentsTasksProjectModal.deleteProject')}
                </Button>
              )}
            </div>

            {/* Cancel and Save buttons (right side) */}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                {tPhaseF('phaseF.componentsTasksProjectModal.cancel')}
              </Button>
              <Button type="button" onClick={handleSave} disabled={!isValid}>
                {isEditMode ? 'Save' : 'Create'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Confirmation */}
      <DeleteProjectDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleConfirmDelete}
        project={project ?? null}
      />

      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsTasksProjectModal.unsavedChanges')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tPhaseF(
                'phaseF.componentsTasksProjectModal.youHaveUnsavedChangesAreYouSureYouWantToDiscardThem'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDiscard}>
              {tPhaseF('phaseF.componentsTasksProjectModal.cancel2')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardChanges}>
              {tPhaseF('phaseF.componentsTasksProjectModal.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export const ProjectModal = (props: ProjectModalProps): React.JSX.Element => {
  return <ProjectModalDialog key={getProjectDialogKey(props.isOpen, props.project)} {...props} />
}

export default ProjectModal
