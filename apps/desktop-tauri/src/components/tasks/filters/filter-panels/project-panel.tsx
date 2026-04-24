import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import type { Project } from '@/data/tasks-data'
import { BackButton } from './priority-panel'

interface ProjectPanelProps {
  projects: Project[]
  selectedProjectIds: string[]
  onToggleProject: (projectId: string) => void
  onClearProjectFilter: () => void
  onGoBack: () => void
}

export function ProjectPanel({
  projects,
  selectedProjectIds,
  onToggleProject,
  onClearProjectFilter,
  onGoBack
}: ProjectPanelProps): React.JSX.Element {
  const visibleProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-muted-foreground"
        >
          <path
            d="M2 4.5V11a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 12 11V5.5A1.5 1.5 0 0 0 10.5 4H7L5.5 2H3.5A1.5 1.5 0 0 0 2 3.5v1z"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
        <span className="text-[13px] text-foreground font-medium leading-4">Project</span>
      </div>
      <div className="flex flex-col p-1">
        <button
          type="button"
          onClick={onClearProjectFilter}
          className={cn(
            'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
            selectedProjectIds.length === 0 ? 'bg-accent' : 'hover:bg-accent'
          )}
        >
          <div className="shrink-0 rounded-[3px] border-[1.2px] border-solid border-border size-2.5" />
          <span className="text-[13px] text-muted-foreground/60 leading-4">No project</span>
          {selectedProjectIds.length === 0 && <CheckMark className="ml-auto text-primary" />}
        </button>
        {visibleProjects.map((project) => {
          const selected = selectedProjectIds.includes(project.id)
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onToggleProject(project.id)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                selected ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <div
                className="shrink-0 rounded-[3px] size-2.5"
                style={{ backgroundColor: project.color }}
              />
              <span
                className={cn(
                  'text-[13px] leading-4',
                  selected ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {project.name}
              </span>
              {selected && <CheckMark className="ml-auto text-primary" />}
            </button>
          )
        })}
      </div>
    </>
  )
}
