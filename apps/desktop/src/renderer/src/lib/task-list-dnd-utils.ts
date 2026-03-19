import type { Project, SortField } from '@/data/tasks-data'

import type {
  GroupHeaderItem,
  ParentTaskItem,
  StatusHeaderItem,
  TaskItem,
  VirtualItem
} from './virtual-list-utils'

type SectionItem = TaskItem | ParentTaskItem
type MutableSortField = Extract<SortField, 'priority' | 'dueDate' | 'project' | 'status'>

interface GroupedAnnotationOptions {
  sortField: SortField
  projects: Project[]
}

const isSectionItem = (item: VirtualItem): item is SectionItem =>
  item.type === 'task' || item.type === 'parent-task'

const annotateSectionItems = (
  items: VirtualItem[],
  sectionId: string,
  sectionTaskIds: string[],
  columnId?: string
): VirtualItem[] =>
  items.map((item) => {
    if (item.type === 'group-header') {
      return {
        ...item,
        sectionId,
        sectionTaskIds,
        columnId
      } satisfies GroupHeaderItem
    }

    if (item.type === 'status-header') {
      return {
        ...item,
        sectionId,
        sectionTaskIds,
        columnId
      } satisfies StatusHeaderItem
    }

    if (isSectionItem(item)) {
      return {
        ...item,
        sectionId,
        sectionTaskIds,
        columnId
      }
    }

    return item
  })

const resolveMutableGroupColumnId = (
  sortField: MutableSortField,
  groupKey: string,
  projects: Project[]
): string | undefined => {
  switch (sortField) {
    case 'priority':
      return `priority-${groupKey}`
    case 'dueDate':
      return groupKey === 'overdue' ? undefined : `due-${groupKey}`
    case 'project':
      return groupKey === 'no-project' ? undefined : `project-${groupKey}`
    case 'status': {
      const status = projects
        .flatMap((project) => project.statuses)
        .find((entry) => entry.id === groupKey)
      if (!status || status.type === 'done') return undefined
      return status.type
    }
  }
}

export const annotateFlatVirtualItems = (
  items: VirtualItem[],
  options: { sectionId?: string; columnId?: string } = {}
): VirtualItem[] => {
  const sectionId = options.sectionId ?? 'flat'
  const sectionTaskIds = items.filter(isSectionItem).map((item) => item.task.id)

  return annotateSectionItems(items, sectionId, sectionTaskIds, options.columnId)
}

export const annotateGroupedVirtualItems = (
  items: VirtualItem[],
  { sortField, projects }: GroupedAnnotationOptions
): VirtualItem[] => {
  const annotatedItems: VirtualItem[] = []
  let activeHeader: GroupHeaderItem | null = null
  let activeItems: VirtualItem[] = []

  const flush = (): void => {
    if (!activeHeader) return

    const sectionId = activeHeader.groupKey
    const sectionTaskIds = activeItems.filter(isSectionItem).map((item) => item.task.id)
    const columnId =
      sortField === 'priority' ||
      sortField === 'dueDate' ||
      sortField === 'project' ||
      sortField === 'status'
        ? resolveMutableGroupColumnId(sortField, activeHeader.groupKey, projects)
        : undefined

    annotatedItems.push(
      ...annotateSectionItems([activeHeader, ...activeItems], sectionId, sectionTaskIds, columnId)
    )

    activeHeader = null
    activeItems = []
  }

  items.forEach((item) => {
    if (item.type === 'group-header') {
      flush()
      activeHeader = item
      return
    }

    if (activeHeader) {
      activeItems.push(item)
      return
    }

    annotatedItems.push(item)
  })

  flush()

  return annotatedItems
}

export const annotateProjectStatusVirtualItems = (items: VirtualItem[]): VirtualItem[] => {
  const annotatedItems: VirtualItem[] = []
  let activeHeader: StatusHeaderItem | null = null
  let activeItems: VirtualItem[] = []

  const flush = (): void => {
    if (!activeHeader) return

    const sectionId = activeHeader.status.id
    const sectionTaskIds = activeItems.filter(isSectionItem).map((item) => item.task.id)
    const columnId = activeHeader.status.id

    annotatedItems.push(
      ...annotateSectionItems([activeHeader, ...activeItems], sectionId, sectionTaskIds, columnId)
    )

    activeHeader = null
    activeItems = []
  }

  items.forEach((item) => {
    if (item.type === 'status-header') {
      flush()
      activeHeader = item
      return
    }

    if (activeHeader) {
      activeItems.push(item)
      return
    }

    annotatedItems.push(item)
  })

  flush()

  return annotatedItems
}
