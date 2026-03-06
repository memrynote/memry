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
    <div className={cn('space-y-1', className)}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 px-2 py-1.5 rounded-md">
          {/* Color dot skeleton */}
          <div className="size-2.5 rounded-full bg-sidebar-accent animate-pulse shrink-0" />

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
