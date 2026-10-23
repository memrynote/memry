import type { OpenTargetTab } from '@/hooks/use-open-target'

/**
 * Custom drag data type set when any note or file item is dragged out of the
 * left sidebar (`VirtualizedNotesTree`). The payload is the item's note id.
 *
 * Consumers:
 * - the note editor embeds a *file* item by its own vault path
 *   (`window.api.notes.getFile(id)`; a markdown note resolves to null → no-op);
 * - a sidebar project drop links the item to the project (file vs note is
 *   resolved via `getFile`).
 */
export const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'

/**
 * Set next to BlockNote's own drag data when a single task block is dragged by
 * its side-menu handle. The payload is the task id. The day panel timeline and
 * its Unscheduled list schedule that task on drop and leave the block in the
 * note.
 */
export const MEMRY_TASK_DRAG_MIME = 'application/x-memry-task'

/**
 * Set when a sidebar row that opens a tab (note, file, canvas) is dragged. The
 * payload is the row's tab data as JSON, the same object a click would open.
 *
 * Consumers:
 * - a pane's native split zones open it in a new split or in that pane;
 * - the note editor turns a markdown note (`type: 'note'`) into a wikilink.
 *
 * Tab data rather than an id: a drop target cannot look a note up cheaply, and
 * the row already knows exactly what it opens.
 */
export const MEMRY_TAB_DRAG_MIME = 'application/x-memry-tab'

export function setTabDragData(dataTransfer: DataTransfer, tab: OpenTargetTab): void {
  dataTransfer.setData(MEMRY_TAB_DRAG_MIME, JSON.stringify(tab))
}

/** Reads the payload on `drop`. Returns null for anything that is not tab data. */
export function readTabDragData(dataTransfer: DataTransfer): OpenTargetTab | null {
  const raw = dataTransfer.getData(MEMRY_TAB_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { type, title, path } = parsed as Partial<OpenTargetTab>
    if (typeof type !== 'string' || typeof title !== 'string' || typeof path !== 'string') {
      return null
    }
    return parsed as OpenTargetTab
  } catch {
    return null
  }
}
