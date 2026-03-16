'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'
import { SidebarGroup, SidebarMenu, useSidebar } from '@/components/ui/sidebar'

interface SidebarSectionProps {
  id: string
  label: string
  defaultExpanded?: boolean
  totalCount?: number
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
}

function SectionChevron({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      className={cn(
        'shrink-0 transition-transform duration-200 ease-in-out',
        expanded && 'rotate-90'
      )}
      aria-hidden="true"
    >
      <path
        d="M3.5 2L7 5.5 3.5 9"
        stroke="#B8B5B0"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const SidebarSection = ({
  id,
  label,
  defaultExpanded = true,
  totalCount,
  children,
  className,
  actions
}: SidebarSectionProps): React.JSX.Element => {
  const { state } = useSidebar()
  const isCollapsed = state === 'collapsed'

  const storageKey = `sidebar-section-${id}-expanded`
  const [isExpanded, setIsExpanded] = React.useState(() => {
    if (typeof window === 'undefined') return defaultExpanded
    try {
      const saved = localStorage.getItem(storageKey)
      return saved !== null ? JSON.parse(saved) : defaultExpanded
    } catch {
      return defaultExpanded
    }
  })

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === storageKey && event.newValue !== null) {
        try {
          setIsExpanded(JSON.parse(event.newValue))
        } catch {
          // Ignore parse errors
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [storageKey])

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

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        handleToggle()
        break
      case 'ArrowRight':
        if (!isExpanded) {
          e.preventDefault()
          handleOpenChange(true)
        }
        break
      case 'ArrowLeft':
        if (isExpanded) {
          e.preventDefault()
          handleOpenChange(false)
        }
        break
    }
  }

  const headerId = `section-header-${id}`
  const contentId = `section-content-${id}`

  if (isCollapsed) {
    return <></>
  }

  return (
    <div className={cn('group/section', className)}>
      <SidebarGroup className="py-0">
        {/* Section Header */}
        <div className="flex items-center [font-synthesis:none] antialiased">
          <button
            id={headerId}
            type="button"
            onClick={handleToggle}
            onKeyDown={handleKeyDown}
            className={cn(
              'flex flex-1 min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5',
              'text-[12px] leading-4 font-medium',
              "font-['DM_Sans',system-ui,sans-serif]",
              'text-[#A3A09B] hover:text-sidebar-foreground',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
            aria-expanded={isExpanded}
            aria-controls={contentId}
            aria-label={`${label} section, ${isExpanded ? 'expanded' : 'collapsed'}${totalCount !== undefined ? `, ${totalCount} items` : ''}`}
            tabIndex={0}
          >
            <SectionChevron expanded={isExpanded} />
            <span className="flex-1 truncate text-left">{label}</span>

            {!isExpanded && totalCount !== undefined && totalCount > 0 && (
              <span className="text-[#A3A09B]/60 tabular-nums text-[11px]">({totalCount})</span>
            )}
          </button>

          {actions && (
            <div
              className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 group-hover/section:opacity-100 transition-opacity duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              {actions}
            </div>
          )}
        </div>

        {/* Accordion content */}
        <div
          id={contentId}
          role="region"
          aria-labelledby={headerId}
          aria-hidden={!isExpanded}
          className={cn(
            'grid transition-[grid-template-rows] duration-100 ease-out',
            isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}
        >
          <div className="overflow-hidden">
            <SidebarMenu>{children}</SidebarMenu>
          </div>
        </div>
      </SidebarGroup>
    </div>
  )
}

export default SidebarSection
