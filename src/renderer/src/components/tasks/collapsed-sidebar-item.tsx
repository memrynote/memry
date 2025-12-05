import React from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface CollapsedSidebarItemProps {
  icon: React.ReactNode
  label: string
  count?: number
  isSelected: boolean
  onClick: () => void
  color?: string
}

export const CollapsedSidebarItem = ({
  icon,
  label,
  count,
  isSelected,
  onClick,
  color,
}: CollapsedSidebarItemProps): React.JSX.Element => {
  const tooltipContent = count !== undefined ? `${label} · ${count}` : label

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "flex h-10 w-full items-center justify-center rounded-md transition-colors",
            "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isSelected && "bg-accent/70"
          )}
          aria-label={label}
        >
          {color ? (
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
          ) : (
            <span className="text-lg" aria-hidden="true">
              {icon}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  )
}

export default CollapsedSidebarItem





