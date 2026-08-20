'use client'

import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  useDndMonitor,
  type Active,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, type SortingStrategy } from '@dnd-kit/sortable'

import { GripVertical } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { reorderSidebarSections, sectionDropEdge } from './sidebar-section-order'

/**
 * Marks a draggable as a sidebar section, so the shared drag handlers can tell
 * one apart from a task or a project row: the app-level drag state only tracks
 * task drags, and its drop switch has no branch for this type.
 */
export const SIDEBAR_SECTION_DRAG_TYPE = 'sidebar-section'

/**
 * Nothing slides out of the way — see `sectionDropEdge`. This also takes
 * dnd-kit out of the business of moving the dragged section: the app mounts a
 * DragOverlay for tasks, and a sortable in a context that has one never gets
 * the drag source's own transform. The section follows the pointer through
 * `dragOffset` instead.
 */
const noDisplacement: SortingStrategy = () => null

const isSectionDrag = (active: Active | null): boolean =>
  active?.data.current?.type === SIDEBAR_SECTION_DRAG_TYPE

export interface SidebarSectionEntry {
  id: string
  /** Used for the drag handle's accessible name only. */
  label: string
  node: React.ReactNode
}

interface SortableSidebarSectionsProps {
  sections: SidebarSectionEntry[]
  onReorder: (ids: string[]) => void
}

interface SortableSidebarSectionProps extends SidebarSectionEntry {
  /** How far the pointer has carried this section, or null when it is at rest. */
  dragOffset: number | null
}

function SortableSidebarSection({
  id,
  label,
  node,
  dragOffset
}: SortableSidebarSectionProps): React.JSX.Element {
  const { t } = useT('common')
  const { attributes, listeners, setNodeRef, transition, isDragging, isOver, activeIndex, index } =
    useSortable({
      id,
      data: { type: SIDEBAR_SECTION_DRAG_TYPE }
    })

  const dropEdge = sectionDropEdge({ isOver, isDragging, activeIndex, index })

  return (
    <div
      ref={setNodeRef}
      data-testid="sidebar-section-sortable"
      data-section-id={id}
      data-drop-edge={dropEdge ?? undefined}
      style={{ transition }}
      className={cn(
        'group/section-drag relative',
        // Section bodies render nothing while the sidebar is in icon mode, so the
        // handle must go with them instead of floating over an empty rail.
        'group-data-[collapsible=icon]:hidden'
      )}
    >
      {dragOffset !== null && (
        <div
          data-testid="sidebar-section-ghost"
          aria-hidden="true"
          // No transition: it has to sit under the pointer, not chase it.
          style={{ transform: `translate3d(0, ${dragOffset}px, 0)` }}
          className="pointer-events-none absolute inset-x-2 top-0 z-30 flex h-6 items-center gap-1.5 rounded-md bg-sidebar px-2 shadow-lg ring-1 ring-sidebar-border"
        >
          <GripVertical className="size-3 shrink-0 text-sidebar-muted" aria-hidden="true" />
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.04em] text-sidebar-section-heading [font-synthesis:none] font-['DM_Sans',system-ui,sans-serif]">
            {label}
          </span>
        </div>
      )}
      {dropEdge && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-2 z-40 h-0.5 rounded-full bg-sidebar-terracotta',
            dropEdge === 'before' ? 'top-0' : 'bottom-0'
          )}
        />
      )}
      <button
        type="button"
        data-testid="sidebar-section-drag"
        aria-label={t('phaseF.componentsAppSidebar.reorderSection', { section: label })}
        // Sits in the gutter the section header already leaves free (the group is
        // px-2, the header button px-2 again), so revealing it shifts nothing.
        className={cn(
          'absolute start-0 top-0 z-10 flex h-6 w-3 cursor-grab items-center justify-center',
          'text-sidebar-muted opacity-0 transition-opacity duration-150',
          'group-hover/section-drag:opacity-100 focus-visible:opacity-100 focus-visible:outline-none'
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3" aria-hidden="true" />
      </button>
      {/* The section stays in place, faded, while a label rides the pointer:
          carrying the whole section is what made this unusable, since
          Collections with its tree open is half the sidebar and covers whatever
          it is being dropped onto. The fade sits here rather than on the
          wrapper because opacity applies to every descendant, and the label
          above must stay opaque enough to read over what it passes. */}
      <div className={cn(isDragging && 'opacity-40')}>{node}</div>
    </div>
  )
}

/**
 * Renders the sidebar's collapsible sections in the user's order and lets them
 * drag one section above another by its handle.
 *
 * There is no DndContext of its own on purpose: the sidebar already lives inside
 * the app-level one (App.tsx → DragProvider), and nesting would re-register the
 * project rows on the inner context, which is what makes dropping a task onto a
 * sidebar project work.
 */
export const SortableSidebarSections = ({
  sections,
  onReorder
}: SortableSidebarSectionsProps): React.JSX.Element => {
  // Keyed on the ids themselves: `sections` is a fresh array every sidebar
  // render, and a new `ids` identity would re-subscribe the drag monitor each
  // time for nothing.
  const idKey = sections.map((section) => section.id).join('\u0000')
  const ids = useMemo(() => idKey.split('\u0000').filter(Boolean), [idKey])

  // Which section is in the air, and how far the pointer has taken it. Updating
  // this on every move re-renders these five wrappers only: each section's body
  // arrives as an element the sidebar already built, so React reuses that
  // subtree untouched.
  const [carried, setCarried] = useState<{ id: string; offsetY: number } | null>(null)

  const clearCarried = useCallback(() => setCarried(null), [])

  const listeners = useMemo(
    () => ({
      onDragStart({ active }: DragStartEvent): void {
        if (!isSectionDrag(active)) return
        setCarried({ id: String(active.id), offsetY: 0 })
      },
      onDragMove({ active, delta }: DragMoveEvent): void {
        if (!isSectionDrag(active)) return
        setCarried({ id: String(active.id), offsetY: delta.y })
      },
      onDragEnd(event: DragEndEvent): void {
        const { active, over } = event
        if (!isSectionDrag(active)) return
        clearCarried()
        if (!over) return

        const next = reorderSidebarSections(ids, String(active.id), String(over.id))
        if (next) onReorder(next)
      },
      onDragCancel: clearCarried
    }),
    [ids, onReorder, clearCarried]
  )

  useDndMonitor(listeners)

  return (
    <SortableContext items={ids} strategy={noDisplacement}>
      {sections.map((section) => (
        <SortableSidebarSection
          key={section.id}
          {...section}
          dragOffset={carried?.id === section.id ? carried.offsetY : null}
        />
      ))}
    </SortableContext>
  )
}

export default SortableSidebarSections
