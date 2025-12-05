import React from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import CollapsedSidebarItem from "./collapsed-sidebar-item"

export interface SidebarView {
  id: string
  label: string
  count: number
  icon: React.ReactNode
}

export interface SidebarProject {
  id: string
  name: string
  taskCount: number
  color: string
}

interface TasksSidebarProps {
  collapsed: boolean
  onToggle: () => void
  views: SidebarView[]
  projects: SidebarProject[]
  selectedId: string
  selectedType: "view" | "project"
  onSelectView: (id: string) => void
  onSelectProject: (id: string) => void
  onNewProject: () => void
  renderExpanded: React.ReactNode
}

export const TasksSidebar = ({
  collapsed,
  onToggle,
  views,
  projects,
  selectedId,
  selectedType,
  onSelectView,
  onSelectProject,
  onNewProject,
  renderExpanded,
}: TasksSidebarProps): React.JSX.Element => {
  if (collapsed) {
    return (
      <div
        className={cn(
          "flex h-full w-14 flex-col border-r border-border bg-surface transition-all duration-200 ease-in-out"
        )}
      >
        <div className="p-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Expand sidebar"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="px-2 space-y-1">
          {views.map((view) => (
            <CollapsedSidebarItem
              key={view.id}
              icon={view.icon}
              label={view.label}
              count={view.count}
              isSelected={selectedType === "view" && selectedId === view.id}
              onClick={() => onSelectView(view.id)}
            />
          ))}
        </div>

        <div className="mx-3 my-2 border-t border-border" />

        <div className="flex-1 px-2 space-y-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="space-y-1 pr-2">
              {projects
                .filter((p) => !p.isArchived)
                .map((project) => (
                  <CollapsedSidebarItem
                    key={project.id}
                    icon={null}
                    label={project.name}
                    count={project.taskCount}
                    color={project.color}
                    isSelected={selectedType === "project" && selectedId === project.id}
                    onClick={() => onSelectProject(project.id)}
                  />
                ))}
            </div>
          </ScrollArea>
        </div>

        <div className="border-t border-border p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewProject}
                className="flex h-10 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="New project"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              New Project
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex h-full w-60 flex-shrink-0 flex-col border-r border-border bg-surface transition-all duration-200 ease-in-out"
      )}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
          Navigation
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-accent hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Collapse sidebar"
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>

      <div className="h-full">{renderExpanded}</div>
    </div>
  )
}

export default TasksSidebar





