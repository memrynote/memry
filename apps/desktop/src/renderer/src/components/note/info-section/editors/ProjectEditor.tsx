import { useState } from 'react'
import { X } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { cn } from '@/lib/utils'
import { useProjectsList } from '@/hooks/use-projects-list'
import { useT } from '@memry/i18n/renderer'
import type { ProjectWithStats } from '@/services/tasks-service'

interface ProjectEditorProps {
  /** Project names, as stored in frontmatter. */
  value: string[]
  defaultOpen?: boolean
  onChange: (value: string[]) => void
}

function ProjectDot({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

/**
 * The `project` property's value: one chip per project name in the note's
 * frontmatter. A name with no matching (non-archived) project — a typo, or a
 * project that was archived — still renders, muted, rather than being
 * silently dropped. Resolution is by name, never by id.
 */
export function ProjectEditor({
  value,
  defaultOpen,
  onChange
}: ProjectEditorProps): React.JSX.Element {
  const { t } = useT('notes')
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false)
  const { projects } = useProjectsList()

  const byName = new Map(projects.map((project) => [project.name.toLowerCase(), project]))
  const chips = value.map((name) => ({ name, project: byName.get(name.toLowerCase()) ?? null }))

  const handleToggle = (name: string): void => {
    const next = value.some((v) => v.toLowerCase() === name.toLowerCase())
      ? value.filter((v) => v.toLowerCase() !== name.toLowerCase())
      : [...value, name]
    onChange(next)
  }

  const handleRemove = (name: string): void => {
    onChange(value.filter((v) => v !== name))
  }

  return (
    <Picker
      mode="multi"
      open={isOpen}
      onOpenChange={setIsOpen}
      value={value}
      onValueChange={handleToggle}
      closeOnSelect={false}
    >
      <Picker.Trigger variant="inline" asChild>
        <span>
          {chips.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {chips.map(({ name, project }) => (
                <span
                  key={name}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
                    project
                      ? 'border-border bg-muted/40'
                      : 'border-dashed border-border text-text-tertiary'
                  )}
                >
                  {project && (
                    <ProjectIcon
                      icon={project.icon}
                      color={project.color}
                      className="size-3 shrink-0"
                      fallback={<ProjectDot color={project.color} />}
                    />
                  )}
                  <span className="max-w-32 truncate">{name}</span>
                  <button
                    type="button"
                    aria-label={t('properties.projectRemove', { name })}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(name)
                    }}
                    className="rounded p-0.5 text-text-tertiary transition-colors hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-[13px] text-text-tertiary font-sans">
              {t('properties.projectPlaceholder')}
            </span>
          )}
        </span>
      </Picker.Trigger>
      <Picker.Content width={220} align="start">
        <Picker.Search placeholder={t('properties.projectSearch')} />
        <Picker.List>
          {projects.length === 0 && <Picker.Empty message={t('properties.projectEmpty')} />}
          {projects.map((project: ProjectWithStats) => (
            <Picker.Item
              key={project.id}
              value={project.name}
              label={project.name}
              indicator="checkbox"
              indicatorColor={project.color}
              icon={
                <ProjectIcon
                  icon={project.icon}
                  color={project.color}
                  className="size-3.5 shrink-0"
                  fallback={<ProjectDot color={project.color} />}
                />
              }
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
