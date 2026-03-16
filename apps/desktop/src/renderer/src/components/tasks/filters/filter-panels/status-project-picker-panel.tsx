import { useMemo } from 'react'

import type { Project } from '@/data/tasks-data'
import { BackButton } from './priority-panel'

interface StatusProjectPickerPanelProps {
  projects: Project[]
  onSelectProject: (projectId: string) => void
  onGoBack: () => void
}

export function StatusProjectPickerPanel({
  projects,
  onSelectProject,
  onGoBack
}: StatusProjectPickerPanelProps): React.JSX.Element {
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
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="text-[12px] text-foreground font-medium leading-4">Status</span>
      </div>
      <div className="px-3 pt-1.5 pb-1">
        <span className="text-[11px] text-text-tertiary leading-3.5">Pick a project</span>
      </div>
      <div className="flex flex-col p-1">
        {visibleProjects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelectProject(project.id)}
            className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
          >
            <div
              className="shrink-0 rounded-[3px] size-2.5"
              style={{ backgroundColor: project.color }}
            />
            <span className="text-[12px] text-text-secondary leading-4">{project.name}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              className="ml-auto text-text-tertiary"
            >
              <path d="M3.5 5l3 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              <path
                d="M5.5 3L7.5 5 5.5 7"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ))}
      </div>
    </>
  )
}
