import { useMemo, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ProjectSelect } from './project-select'
import { StatusSelect } from './status-select'
import { DueDatePicker } from './due-date-picker'
import { PrioritySelect } from './priority-select'
import { RepeatPicker } from './repeat-picker'
import { CustomRepeatDialog } from './custom-repeat-dialog'
import { cn } from '@/lib/utils'
import { getDefaultTodoStatus } from '@/lib/task-utils'
import { createDefaultTask, type Task, type Priority, type RepeatConfig } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

interface AddTaskModalProps {
  isOpen: boolean
  onClose: () => void
  onAddTask: (task: Task) => void
  projects: Project[]
  defaultProjectId?: string
  defaultDueDate?: Date | null
  prefillTitle?: string
}

interface TaskFormData {
  title: string
  description: string
  projectId: string
  statusId: string
  dueDate: Date | null
  dueTime: string | null
  priority: Priority
  repeatConfig: RepeatConfig | null
}

interface FormErrors {
  title?: string
}

function buildInitialFormData({
  defaultProjectId,
  defaultDueDate,
  prefillTitle,
  projects
}: {
  defaultProjectId: string
  defaultDueDate: Date | null
  prefillTitle: string
  projects: Project[]
}): TaskFormData {
  const project = projects.find((candidate) => candidate.id === defaultProjectId)
  const defaultStatus = project ? getDefaultTodoStatus(project) : null
  const statusId = defaultStatus?.id || project?.statuses[0]?.id || ''

  return {
    title: prefillTitle,
    description: '',
    projectId: defaultProjectId,
    statusId,
    dueDate: defaultDueDate,
    dueTime: null,
    priority: 'none',
    repeatConfig: null
  }
}

interface AddTaskModalSessionProps {
  initialFormData: TaskFormData
  onClose: () => void
  onAddTask: (task: Task) => void
  projects: Project[]
}

function AddTaskModalSession({
  initialFormData,
  onClose,
  onAddTask,
  projects
}: AddTaskModalSessionProps): React.JSX.Element {
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [formData, setFormData] = useState<TaskFormData>(initialFormData)
  const [errors, setErrors] = useState<FormErrors>({})
  const [createAnother, setCreateAnother] = useState(false)
  const [isCustomRepeatDialogOpen, setIsCustomRepeatDialogOpen] = useState(false)

  const currentProject = useMemo(() => {
    return projects.find((project) => project.id === formData.projectId)
  }, [projects, formData.projectId])

  const currentStatuses = useMemo(() => {
    return currentProject?.statuses || []
  }, [currentProject])

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setFormData((prev) => ({ ...prev, title: e.target.value }))
    if (errors.title) {
      setErrors((prev) => ({ ...prev, title: undefined }))
    }
  }

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setFormData((prev) => ({ ...prev, description: e.target.value }))
  }

  const handleProjectChange = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId)
    const defaultStatus = project ? getDefaultTodoStatus(project) : null
    const statusId = defaultStatus?.id || project?.statuses[0]?.id || ''

    setFormData((prev) => ({
      ...prev,
      projectId,
      statusId
    }))
  }

  const handleStatusChange = (statusId: string): void => {
    setFormData((prev) => ({ ...prev, statusId }))
  }

  const handleDueDateChange = (date: Date | null): void => {
    setFormData((prev) => ({ ...prev, dueDate: date }))
  }

  const handleDueTimeChange = (time: string | null): void => {
    setFormData((prev) => ({ ...prev, dueTime: time }))
  }

  const handlePriorityChange = (priority: Priority): void => {
    setFormData((prev) => ({ ...prev, priority }))
  }

  const handleRepeatConfigChange = (repeatConfig: RepeatConfig | null): void => {
    setFormData((prev) => ({ ...prev, repeatConfig }))
  }

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (): void => {
    if (!validateForm()) {
      titleInputRef.current?.focus()
      return
    }

    const newTask = createDefaultTask(
      formData.projectId,
      formData.statusId,
      formData.title.trim(),
      formData.dueDate
    )

    const finalTask: Task = {
      ...newTask,
      description: formData.description.trim(),
      dueTime: formData.dueTime,
      priority: formData.priority,
      isRepeating: formData.repeatConfig !== null,
      repeatConfig: formData.repeatConfig
    }

    onAddTask(finalTask)

    if (createAnother) {
      setFormData((prev) => ({
        title: '',
        description: '',
        projectId: prev.projectId,
        statusId: getDefaultTodoStatus(currentProject!)?.id || prev.statusId,
        dueDate: prev.dueDate,
        dueTime: null,
        priority: 'none',
        repeatConfig: null
      }))
      setErrors({})
      titleInputRef.current?.focus()
      return
    }

    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <>
      <DialogContent className="max-w-lg" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Add Task</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="task-title"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              ref={titleInputRef}
              id="task-title"
              autoFocus
              value={formData.title}
              onChange={handleTitleChange}
              placeholder="What needs to be done?"
              className={cn(errors.title && 'border-destructive')}
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? 'title-error' : undefined}
            />
            {errors.title && (
              <p id="title-error" className="text-sm text-destructive">
                {errors.title}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="task-description"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Description
            </label>
            <textarea
              id="task-description"
              value={formData.description}
              onChange={handleDescriptionChange}
              placeholder="Add details, notes, or links..."
              rows={3}
              className={cn(
                'flex min-h-[80px] w-full rounded-sm border border-input bg-transparent px-3 py-2 text-sm shadow-sm',
                'placeholder:text-muted-foreground focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50 resize-none'
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Project
              </label>
              <ProjectSelect
                value={formData.projectId}
                onChange={handleProjectChange}
                projects={projects}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Status
              </label>
              <StatusSelect
                value={formData.statusId}
                onChange={handleStatusChange}
                statuses={currentStatuses}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Due Date
              </label>
              <DueDatePicker
                date={formData.dueDate}
                time={formData.dueTime}
                onDateChange={handleDueDateChange}
                onTimeChange={handleDueTimeChange}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Priority
              </label>
              <PrioritySelect value={formData.priority} onChange={handlePriorityChange} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Repeat
            </label>
            <RepeatPicker
              value={formData.repeatConfig}
              dueDate={formData.dueDate}
              onChange={handleRepeatConfigChange}
              onOpenCustomDialog={() => setIsCustomRepeatDialogOpen(true)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="create-another"
              checked={createAnother}
              onCheckedChange={(checked) => setCreateAnother(checked === true)}
            />
            <label
              htmlFor="create-another"
              className="text-sm text-muted-foreground cursor-pointer"
            >
              Create another
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>Add Task</Button>
          </div>
        </div>
      </DialogContent>

      <CustomRepeatDialog
        isOpen={isCustomRepeatDialogOpen}
        onClose={() => setIsCustomRepeatDialogOpen(false)}
        onSave={(config) => {
          handleRepeatConfigChange(config)
          setIsCustomRepeatDialogOpen(false)
        }}
        initialConfig={formData.repeatConfig}
        dueDate={formData.dueDate}
      />
    </>
  )
}

export const AddTaskModal = ({
  isOpen,
  onClose,
  onAddTask,
  projects,
  defaultProjectId = 'personal',
  defaultDueDate = null,
  prefillTitle = ''
}: AddTaskModalProps): React.JSX.Element => {
  const initialFormData = useMemo(
    () =>
      buildInitialFormData({
        defaultProjectId,
        defaultDueDate,
        prefillTitle,
        projects
      }),
    [defaultProjectId, defaultDueDate, prefillTitle, projects]
  )
  const formKey = `${defaultProjectId}:${defaultDueDate?.toISOString() ?? 'none'}:${prefillTitle}`

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {isOpen ? (
        <AddTaskModalSession
          key={formKey}
          initialFormData={initialFormData}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={projects}
        />
      ) : null}
    </Dialog>
  )
}

export default AddTaskModal
