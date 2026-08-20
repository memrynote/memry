'use client'

import * as React from 'react'
import { useMemo } from 'react'
import { useDndMonitor, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { GripVertical } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { reorderSidebarSections } from './sidebar-section-order'

/**
 * Marks a draggable as a sidebar section, so the shared drag handlers can tell
 * one apart from a task or a project row: the app-level drag state only tracks
 * task drags, and its drop switch has no branch for this type.
 */
export const SIDEBAR_SECTION_DRAG_TYPE = 'sidebar-section'

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

function SortableSidebarSection({ id, label, node }: SidebarSectionEntry): React.JSX.Element {
  const { t } = useT('common')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: SIDEBAR_SECTION_DRAG_TYPE }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="sidebar-section-sortable"
      data-section-id={id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/section-drag relative',
        // Section bodies render nothing while the sidebar is in icon mode, so the
        // handle must go with them instead of floating over an empty rail.
        'group-data-[collapsible=icon]:hidden',
        isDragging && 'z-10 opacity-80'
      )}
    >
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
      {node}
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

  const listeners = useMemo(
    () => ({
      onDragEnd(event: DragEndEvent): void {
        const { active, over } = event
        if (active.data.current?.type !== SIDEBAR_SECTION_DRAG_TYPE) return
        if (!over) return

        const next = reorderSidebarSections(ids, String(active.id), String(over.id))
        if (next) onReorder(next)
      }
    }),
    [ids, onReorder]
  )

  useDndMonitor(listeners)

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {sections.map((section) => (
        <SortableSidebarSection key={section.id} {...section} />
      ))}
    </SortableContext>
  )
}

export default SortableSidebarSections
