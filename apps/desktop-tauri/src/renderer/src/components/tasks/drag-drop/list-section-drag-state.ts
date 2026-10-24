import type { DragState } from '@/contexts/drag-context'

export type SectionDragState = 'none' | 'source-dimmed' | 'target-highlighted'

const LIST_DROP_SPACER_HEIGHT = 40
const LIST_MULTI_DROP_STACK_OFFSET = 6

export const isCrossSectionListDrag = (dragState: DragState): boolean =>
  dragState.isDragging &&
  dragState.sourceType === 'list' &&
  dragState.sourceContainerId !== null &&
  dragState.overSectionId !== null &&
  dragState.sourceContainerId !== dragState.overSectionId

export const resolveSectionDragState = (
  dragState: DragState,
  sectionId?: string
): SectionDragState => {
  if (!sectionId || !isCrossSectionListDrag(dragState)) {
    return 'none'
  }

  if (dragState.sourceContainerId === sectionId) {
    return 'source-dimmed'
  }

  if (dragState.overSectionId === sectionId) {
    return 'target-highlighted'
  }

  return 'none'
}

export const getCrossSectionDropSpacerHeight = (
  dragState: DragState,
  sectionId?: string
): number => {
  if (
    resolveSectionDragState(dragState, sectionId) !== 'target-highlighted' ||
    dragState.sectionDropPosition !== 'start'
  ) {
    return 0
  }

  const previewCount = Math.max(Math.min(dragState.activeIds.length, 3), 1)
  return LIST_DROP_SPACER_HEIGHT + (previewCount - 1) * LIST_MULTI_DROP_STACK_OFFSET
}

export const resolveTaskInsertionIndicatorPosition = (
  dragState: DragState,
  taskId: string,
  sectionId: string,
  sectionTaskIds?: string[]
): 'before' | 'after' | undefined => {
  if (
    !dragState.isDragging ||
    dragState.overType !== 'task' ||
    dragState.overId !== taskId ||
    dragState.overSectionId !== sectionId ||
    !dragState.activeId ||
    dragState.activeId === taskId
  ) {
    return undefined
  }

  if (dragState.overTaskEdge) {
    return dragState.overTaskEdge
  }

  if (
    dragState.sourceContainerId !== sectionId ||
    !sectionTaskIds ||
    dragState.activeIds.length !== 1
  ) {
    return undefined
  }

  const activeIndex = sectionTaskIds.indexOf(dragState.activeId)
  const overIndex = sectionTaskIds.indexOf(taskId)

  if (activeIndex === -1 || overIndex === -1) {
    return undefined
  }

  return activeIndex < overIndex ? 'after' : 'before'
}

export const shouldSuppressCrossSectionListTransform = (dragState: DragState): boolean =>
  isCrossSectionListDrag(dragState)
