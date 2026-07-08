import { useMemo, useRef, useState } from 'react'

import { useT } from '@memry/i18n/renderer'
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
import { TaskDescriptionEditor } from './task-description-editor'
import { cn } from '@/lib/utils'
import { getDefaultTodoStatus } from '@/lib/task-utils'
import { createDefaultTask, type Task, type Priority, type RepeatConfig } from '@/data/task-model'
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
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
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

  const handleDescriptionChange = (markdown: string): void => {
    setFormData((prev) => ({ ...prev, description: markdown }))
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
      newErrors.title = t('task.titleRequired')
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
          <DialogTitle>{t('task.add')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="task-title"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('task.title')} <span className="text-destructive">*</span>
            </label>
            <Input
              ref={titleInputRef}
              id="task-title"
              autoFocus
              value={formData.title}
              onChange={handleTitleChange}
              placeholder={t('task.titlePlaceholder')}
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
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('task.description')}
            </span>
            <TaskDescriptionEditor
              initialContent={formData.description}
              onContentChange={handleDescriptionChange}
              placeholder={t('task.descriptionPlaceholder')}
              ariaLabel={t('task.description')}
              className={cn(
                'min-h-[80px] w-full rounded-sm border border-input bg-transparent px-3 py-2 text-sm shadow-sm'
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('task.project')}
              </label>
              <ProjectSelect
                value={formData.projectId}
                onChange={handleProjectChange}
                projects={projects}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('task.status')}
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
                {t('task.dueDate')}
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
                {t('task.priority')}
              </label>
              <PrioritySelect value={formData.priority} onChange={handlePriorityChange} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('task.repeat')}
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
              {t('task.createAnother')}
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              {tCommon('button.cancel')}
            </Button>
            <Button onClick={handleSubmit}>{t('task.add')}</Button>
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
