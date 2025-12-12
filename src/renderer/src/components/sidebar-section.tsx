"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"

import { cn } from "@/lib/utils"
import {
  SidebarGroup,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar"

interface SidebarSectionProps {
  id: string
  label: string
  defaultExpanded?: boolean
  totalCount?: number
  children: React.ReactNode
  className?: string
}

export const SidebarSection = ({
  id,
  label,
  defaultExpanded = true,
  totalCount,
  children,
  className,
}: SidebarSectionProps): React.JSX.Element => {
  const { state } = useSidebar()
  const isCollapsed = state === "collapsed"

  // Persist expanded state in localStorage
  const storageKey = `sidebar-section-${id}-expanded`
  const [isExpanded, setIsExpanded] = React.useState(() => {
    if (typeof window === "undefined") return defaultExpanded
    try {
      const saved = localStorage.getItem(storageKey)
      return saved !== null ? JSON.parse(saved) : defaultExpanded
    } catch {
      return defaultExpanded
    }
  })

  const handleOpenChange = (open: boolean): void => {
    setIsExpanded(open)
    try {
      localStorage.setItem(storageKey, JSON.stringify(open))
    } catch {
      // Ignore storage errors
    }
  }

  const handleToggle = (): void => {
    handleOpenChange(!isExpanded)
  }

  // Keyboard navigation handler
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault()
        handleToggle()
        break
      case "ArrowRight":
        if (!isExpanded) {
          e.preventDefault()
          handleOpenChange(true)
        }
        break
      case "ArrowLeft":
        if (isExpanded) {
          e.preventDefault()
          handleOpenChange(false)
        }
        break
    }
  }

  // IDs for ARIA
  const headerId = `section-header-${id}`
  const contentId = `section-content-${id}`

  // When sidebar is collapsed to icon mode, hide the section
  if (isCollapsed) {
    return <></>
  }

  return (
    <div className={cn("group/collapsible", className)}>
      <SidebarGroup className="py-0">
        {/* Section Header Button */}
        <button
          id={headerId}
          type="button"
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 rounded-md",
            "text-xs font-medium uppercase tracking-wide",
            "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
            "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          aria-label={`${label} section, ${isExpanded ? "expanded" : "collapsed"}${totalCount !== undefined ? `, ${totalCount} items` : ""}`}
          tabIndex={0}
        >
          {/* Chevron */}
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform duration-200 ease-in-out",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />

          {/* Label */}
          <span className="flex-1 text-left">{label}</span>

          {/* Total count (shown when collapsed) */}
          {!isExpanded && totalCount !== undefined && totalCount > 0 && (
            <span className="text-sidebar-foreground/50 tabular-nums text-xs">
              ({totalCount})
            </span>
          )}
        </button>

        {/* Section Content with Animation */}
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              id={contentId}
              role="region"
              aria-labelledby={headerId}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <SidebarMenu className="mt-1 space-y-0.5">
                {children}
              </SidebarMenu>
            </motion.div>
          )}
        </AnimatePresence>
      </SidebarGroup>
    </div>
  )
}

export default SidebarSection








