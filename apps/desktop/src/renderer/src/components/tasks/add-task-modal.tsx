import { useMemo, useRef, useState } from 'react'

import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { InteractiveStatusBadge } from './interactive-status-badge'
import { InteractivePriorityBadge } from './interactive-priority-badge'
import { InteractiveDueDateBadge } from './interactive-due-date-badge'
import { InteractiveProjectBadge } from './interactive-project-badge'
import { TaskRepeatSection } from './task-repeat-section'
import { TaskDescriptionEditor } from './task-description-editor'
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
  tags: string[]
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
    repeatConfig: null,
    tags: []
  }
}

// Compact property row matching the detail drawer's 90px label column.
const PropertyRow = ({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element => (
  <div className="flex items-center py-1.5">
    <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">{label}</span>
    {children}
  </div>
)

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

  const currentProject = useMemo(() => {
    return projects.find((project) => project.id === formData.projectId)
  }, [projects, formData.projectId])

  const currentStatuses = useMemo(() => {
    return currentProject?.statuses || []
  }, [currentProject])

  const projectColor = currentProject?.color ?? 'var(--text-tertiary)'

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

    setFormData((prev) => ({ ...prev, projectId, statusId }))
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

  const handleTagsChange = (tags: string[]): void => {
    setFormData((prev) => ({ ...prev, tags }))
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
      repeatConfig: formData.repeatConfig,
      tags: formData.tags
    }

    onAddTask(finalTask)

    if (createAnother) {
      setFormData((prev) => ({
        title: '',
        description: '',
        projectId: prev.projectId,
        statusId: currentProject
          ? getDefaultTodoStatus(currentProject)?.id || prev.statusId
          : prev.statusId,
        dueDate: prev.dueDate,
        dueTime: null,
        priority: 'none',
        repeatConfig: null,
        tags: []
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
    <DialogContent
      className="p-0 gap-0 grid-rows-[auto_1fr_auto] max-h-[85vh] overflow-hidden bg-surface [font-synthesis:none]"
      onKeyDown={handleKeyDown}
      aria-describedby={undefined}
    >
      {/* ── Header ── */}
      <div className="flex items-center shrink-0 py-3.5 ps-5 pe-10 border-b border-border">
        <DialogTitle className="text-[14px] font-medium text-text-primary leading-none tracking-normal">
          {t('task.add')}
        </DialogTitle>
      </div>

      {/* ── Scrollable body ── */}
      <div className="min-h-0 overflow-y-auto scrollbar-thin text-[12px] leading-4">
        {/* Title */}
        <div className="px-5 pt-4 pb-1">
          <input
            ref={titleInputRef}
            autoFocus
            value={formData.title}
            onChange={handleTitleChange}
            placeholder={t('task.titlePlaceholder')}
            aria-label={t('task.title')}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'title-error' : undefined}
            className="w-full text-[14px] font-medium text-text-primary bg-transparent outline-none placeholder:text-text-tertiary"
          />
          {errors.title && (
            <p id="title-error" className="mt-1 text-[12px] text-destructive leading-4">
              {errors.title}
            </p>
          )}
        </div>

        {/* Property grid */}
        <div className="flex flex-col pt-1 pb-4 px-5 border-b border-border">
          <PropertyRow label={t('task.status')}>
            <InteractiveStatusBadge
              statusId={formData.statusId}
              statuses={currentStatuses}
              onStatusChange={handleStatusChange}
            />
          </PropertyRow>
          <PropertyRow label={t('task.priority')}>
            <InteractivePriorityBadge
              priority={formData.priority}
              onPriorityChange={handlePriorityChange}
              compact
            />
          </PropertyRow>
          <PropertyRow label={t('task.dueDate')}>
            <InteractiveDueDateBadge
              dueDate={formData.dueDate}
              dueTime={formData.dueTime}
              onDateChange={handleDueDateChange}
              onTimeChange={handleDueTimeChange}
              isRepeating={formData.repeatConfig !== null}
            />
          </PropertyRow>
          <PropertyRow label={t('task.project')}>
            <InteractiveProjectBadge
              projectId={formData.projectId}
              projects={projects}
              onProjectChange={handleProjectChange}
              allowCreate
            />
          </PropertyRow>
        </div>

        {/* Tags — brings its own px-5/border chrome, sits full-bleed */}
        <TagAutocomplete
          tags={formData.tags}
          onTagsChange={handleTagsChange}
          placeholder={t('task.tags')}
        />

        {/* Description */}
        <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            {t('task.description')}
          </span>
          <TaskDescriptionEditor
            initialContent={formData.description}
            onContentChange={handleDescriptionChange}
            placeholder={t('task.descriptionPlaceholder')}
            ariaLabel={t('task.description')}
            className="text-[13px] leading-5 text-text-secondary"
          />
        </div>

        {/* Repeat — brings its own px-5/border chrome, sits full-bleed */}
        <TaskRepeatSection
          taskTitle={formData.title}
          repeatConfig={formData.repeatConfig}
          isRepeating={formData.repeatConfig !== null}
          dueDate={formData.dueDate}
          projectColor={projectColor}
          onRepeatChange={handleRepeatConfigChange}
        />
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between shrink-0 py-3 px-5 border-t border-border">
        <div className="flex items-center gap-2">
          <Checkbox
            id="create-another"
            checked={createAnother}
            onCheckedChange={(checked) => setCreateAnother(checked === true)}
          />
          <label
            htmlFor="create-another"
            className="text-[12px] text-text-secondary cursor-pointer leading-4"
          >
            {t('task.createAnother')}
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {tCommon('button.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit}>
            {t('task.add')}
          </Button>
        </div>
      </div>
    </DialogContent>
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
    () => buildInitialFormData({ defaultProjectId, defaultDueDate, prefillTitle, projects }),
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
