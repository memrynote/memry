import { createElement, useState, useCallback, useMemo } from 'react'

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
import { IconPicker, getIconByName } from '@/components/icon-picker'
import { ColorPicker } from '@/components/tasks/color-picker'
import { StatusEditor } from '@/components/tasks/status-editor'
import { cn } from '@/lib/utils'
import {
  type Project,
  type Status,
  createDefaultProject,
  generateId,
  validateProject,
  type ProjectValidationErrors
} from '@/data/tasks-data'

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

const ProjectIconPreview = ({ iconName }: { iconName: string }): React.JSX.Element => {
  const Icon = getIconByName(iconName)

  if (!Icon) {
    return <span className="text-2xl">📁</span>
  }

  return createElement(Icon, { className: 'size-6 text-text-secondary' })
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
  const isEditMode = !!project
  const canDelete = isEditMode && !project.isDefault
  const initialFormData = useMemo(() => getInitialFormData(project), [project])

  // Form state
  const [formData, setFormData] = useState<FormData>(() => initialFormData)

  // Icon picker state
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false)
  const [iconPickerPosition, setIconPickerPosition] = useState({ x: 0, y: 0 })

  // Unsaved changes dialog
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)

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
    if (onDelete && project) {
      onDelete(project.id)
    }
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

  const handleIconClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    setIconPickerPosition({ x: rect.left, y: rect.bottom + 8 })
    setIsIconPickerOpen(true)
  }

  const handleIconSelect = (iconName: string): void => {
    setFormData((prev) => ({ ...prev, icon: iconName || 'Folder' }))
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
                Icon & Name
              </label>
              <div className="flex items-center gap-3">
                {/* Icon Button */}
                <button
                  type="button"
                  onClick={handleIconClick}
                  className={cn(
                    'flex size-12 shrink-0 items-center justify-center rounded-sm border-2 border-dashed',
                    'transition-colors hover:border-primary hover:bg-accent/50',
                    'focus-visible:outline-none'
                  )}
                  aria-label="Select icon"
                >
                  <ProjectIconPreview iconName={formData.icon} />
                </button>

                {/* Name Input */}
                <div className="flex-1">
                  <Input
                    type="text"
                    value={formData.name}
                    onChange={handleNameChange}
                    placeholder="Project name"
                    maxLength={50}
                    className={cn(errors.name && 'border-destructive')}
                    autoFocus
                  />
                  {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
                </div>
              </div>
              <p className="text-xs text-text-tertiary">Click icon to change</p>
            </div>

            <Separator />

            {/* Color Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Color
              </label>
              <ColorPicker value={formData.color} onChange={handleColorChange} />
            </div>

            <Separator />

            {/* Description Section */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Description (optional)
              </label>
              <textarea
                value={formData.description}
                onChange={handleDescriptionChange}
                placeholder="Brief description of this project..."
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
                Statuses
              </label>
              <p className="text-xs text-text-tertiary">
                Configure the workflow stages for this project.
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
                  Delete Project
                </Button>
              )}
            </div>

            {/* Cancel and Save buttons (right side) */}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={!isValid}>
                {isEditMode ? 'Save' : 'Create'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Icon Picker */}
      <IconPicker
        isOpen={isIconPickerOpen}
        onClose={() => setIsIconPickerOpen(false)}
        onSelect={handleIconSelect}
        position={iconPickerPosition}
        currentIcon={formData.icon}
      />

      {/* Unsaved Changes Confirmation */}
      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Are you sure you want to discard them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDiscard}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardChanges}>Discard</AlertDialogAction>
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
