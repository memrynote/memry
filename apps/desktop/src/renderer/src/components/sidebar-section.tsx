'use client'

import * as React from 'react'

import { ChevronRight } from '@/lib/icons'
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
    <ChevronRight
      size={10}
      className={cn(
        // Decorative to assistive tech, but it is the header's only visible
        // focus state: the header sets `focus-visible:outline-none` and the app
        // paints no global focus ring, so a chevron that stayed at `opacity-0`
        // would leave a keyboard user with nothing on screen at all.
        'shrink-0 text-sidebar-muted transition-transform duration-200 ease-in-out opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100',
        expanded && 'rotate-90'
      )}
      aria-hidden="true"
    />
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
      <SidebarGroup className="p-0 px-2">
        {/* Section Header */}
        <div className="flex items-center h-6 [font-synthesis:none]">
          <button
            id={headerId}
            type="button"
            onClick={handleToggle}
            onKeyDown={handleKeyDown}
            className={cn(
              'flex flex-1 min-w-0 cursor-pointer items-center gap-1.5 px-2 py-1 h-6 shrink-0',
              'text-[11px] leading-3.5 font-medium tracking-[0.04em]',
              "font-['DM_Sans',system-ui,sans-serif]",
              // Resting colour only. `hover:text-sidebar-foreground` used to live
              // here, and on the paper sidebar that is 3.18:1 — under the 4.5:1 AA
              // floor for 11px text — so the heading lost its guarantee exactly
              // while being pointed at. The chevron fading in carries the affordance.
              'text-sidebar-section-heading',
              'focus-visible:outline-none'
            )}
            aria-expanded={isExpanded}
            aria-controls={contentId}
            aria-label={`${label} section, ${isExpanded ? 'expanded' : 'collapsed'}${totalCount !== undefined ? `, ${totalCount} items` : ''}`}
            tabIndex={0}
          >
            <span className="truncate text-start uppercase">{label}</span>
            <SectionChevron expanded={isExpanded} />

            {!isExpanded && totalCount !== undefined && totalCount > 0 && (
              // The count is the only thing left telling you how much a
              // collapsed section hides, so it is informational text, not
              // decoration: `--sidebar-muted` at 60% was 1.43:1 on the paper
              // sidebar. The heading token carries it at 5.07:1.
              <span className="text-sidebar-section-heading tabular-nums text-[10px] leading-3">
                ({totalCount})
              </span>
            )}
          </button>

          {actions && (
            <div
              // Every action in here is in the tab order, so hover cannot be
              // the only thing that reveals them — a keyboard user would land
              // on a control painted at `opacity-0` (WCAG 2.4.7).
              className="flex shrink-0 items-center gap-0.5 pe-2 opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 transition-opacity duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              {actions}
            </div>
          )}
        </div>

        {/* Accordion content */}
        <section
          id={contentId}
          aria-labelledby={headerId}
          aria-hidden={!isExpanded}
          className={cn(
            'grid transition-[grid-template-rows] duration-100 ease-out',
            isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}
        >
          <div className="overflow-hidden">
            <SidebarMenu className="gap-0">{children}</SidebarMenu>
          </div>
        </section>
      </SidebarGroup>
    </div>
  )
}

export default SidebarSection
