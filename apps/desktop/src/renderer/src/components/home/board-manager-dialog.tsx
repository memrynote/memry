import { useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { GripVertical, Pencil, Trash } from '@/lib/icons/icon-map'
import { cn } from '@/lib/utils'
import type { HomePage } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface BoardManagerDialogProps {
  boards: HomePage[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onReorder: (ids: string[]) => void
}

interface BoardRowProps {
  board: HomePage
  editing: boolean
  draft: string
  canDelete: boolean
  onDraftChange: (value: string) => void
  onStartRename: () => void
  onCommitRename: () => void
  onDelete: () => void
}

function BoardRow({
  board,
  editing,
  draft,
  canDelete,
  onDraftChange,
  onStartRename,
  onCommitRename,
  onDelete
}: BoardRowProps): React.JSX.Element {
  const { t } = useT('common')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: board.id
  })

  return (
    <li
      ref={setNodeRef}
      data-testid="board-manager-row"
      data-board-id={board.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/50',
        isDragging && 'relative z-10 bg-muted/60 shadow-sm'
      )}
    >
      <button
        type="button"
        data-testid="board-manager-drag"
        aria-label={t('home.board.reorderAria')}
        className="inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>

      {editing ? (
        <Input
          data-testid="board-manager-name-input"
          aria-label={t('home.board.nameLabel')}
          value={draft}
          autoFocus
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommitRename()
            }
          }}
          className="h-7 flex-1 text-sm"
        />
      ) : (
        <button
          type="button"
          data-testid="board-manager-name"
          onDoubleClick={onStartRename}
          onClick={onStartRename}
          className="flex-1 truncate rounded px-1 text-start text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
        >
          {board.name}
        </button>
      )}

      <button
        type="button"
        data-testid="board-manager-rename"
        aria-label={t('home.board.renameAria')}
        onClick={onStartRename}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="board-manager-delete"
        aria-label={t('home.board.deleteAria')}
        disabled={!canDelete}
        onClick={onDelete}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * Rename, reorder and delete Home boards.
 *
 * Lives in a dialog rather than inside the switcher dropdown on purpose: a Radix menu
 * restores focus to its trigger when its content unmounts, which blurs any inline field
 * a menu item just opened (see canvas-row-menu).
 */
export function BoardManagerDialog({
  boards,
  open,
  onOpenChange,
  onRename,
  onDelete,
  onReorder
}: BoardManagerDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Reorder round-trips through the main process and comes back as a refetch, so hold
  // the dragged order locally until the refreshed list agrees with it.
  const [pendingIds, setPendingIds] = useState<string[] | null>(null)

  // Reset while closed, during render — no effect needed.
  const [openSnapshot, setOpenSnapshot] = useState(open)
  if (open !== openSnapshot) {
    setOpenSnapshot(open)
    if (!open) {
      setEditingId(null)
      setPendingIds(null)
    }
  }

  const orderedBoards = useMemo(() => {
    if (!pendingIds) return boards
    const byId = new Map(boards.map((b) => [b.id, b]))
    const ordered = pendingIds
      .map((id) => byId.get(id))
      .filter((b): b is HomePage => b !== undefined)
    // A peer's create can land while the local order is still in flight.
    const rest = boards.filter((b) => !pendingIds.includes(b.id))
    return [...ordered, ...rest]
  }, [boards, pendingIds])

  if (pendingIds && orderedBoards.every((b, i) => b.id === boards[i]?.id)) setPendingIds(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const commitRename = (): void => {
    if (!editingId) return
    const next = draft.trim()
    const current = boards.find((b) => b.id === editingId)
    if (next && current && next !== current.name) onRename(editingId, next)
    setEditingId(null)
  }

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = orderedBoards.map((b) => b.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    const next = arrayMove(ids, from, to)
    setPendingIds(next)
    onReorder(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="board-manager"
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          // Radix dismisses on a document-level keydown, so an inline edit has to
          // decline it here — a stopPropagation on the input never reaches it.
          if (!editingId) return
          event.preventDefault()
          setEditingId(null)
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('home.board.manageTitle')}</DialogTitle>
          <DialogDescription>{t('home.board.manageDescription')}</DialogDescription>
        </DialogHeader>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedBoards.map((b) => b.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-0.5 py-1">
              {orderedBoards.map((board) => (
                <BoardRow
                  key={board.id}
                  board={board}
                  editing={editingId === board.id}
                  draft={draft}
                  canDelete={boards.length > 1}
                  onDraftChange={setDraft}
                  onStartRename={() => {
                    setEditingId(board.id)
                    setDraft(board.name)
                  }}
                  onCommitRename={commitRename}
                  onDelete={() => onDelete(board.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </DialogContent>
    </Dialog>
  )
}
