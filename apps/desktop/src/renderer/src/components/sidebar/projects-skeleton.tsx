import { cn } from '@/lib/utils'

interface ProjectsSkeletonProps {
  count?: number
  className?: string
}

/**
 * Loading skeleton for the projects list in the sidebar
 * Shows animated placeholder items while projects are loading
 */
export const ProjectsSkeleton = ({
  count = 3,
  className
}: ProjectsSkeletonProps): React.JSX.Element => {
  return (
    <div className={cn('ms-1', className)}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex h-7 items-center gap-1.5 ps-1 pe-2.5 rounded-[5px] pb-px">
          {/* Color dot skeleton — same leading slots as a real project row */}
          <div className="flex shrink-0 items-center gap-0.5">
            <div className="size-4" />
            <div className="flex size-5 items-center justify-center">
              <div className="size-2.5 rounded-full bg-sidebar-accent animate-pulse" />
            </div>
          </div>

          {/* Project name skeleton */}
          <div
            className="flex-1 h-4 bg-sidebar-accent rounded animate-pulse"
            style={{
              // Vary widths for more natural look
              width: `${60 + ((index * 10) % 30)}%`
            }}
          />

          {/* Task count skeleton */}
          <div className="w-6 h-4 bg-sidebar-accent rounded animate-pulse shrink-0" />
        </div>
      ))}
    </div>
  )
}

export default ProjectsSkeleton
