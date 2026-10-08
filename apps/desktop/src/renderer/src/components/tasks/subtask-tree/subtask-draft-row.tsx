import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import type { Task } from '@/data/task-model'
import { useSubtaskTree } from './subtask-tree-context'
import { useTaskExpansion } from './task-expansion-context'

interface SubtaskDraftRowProps {
  parent: Task
  /** The parent's current subtasks; the last one is the row above the draft. */
  siblings: Task[]
  /** The draft's own depth: 1 under a top-level task. */
  depth: number
  /** The parent's parent, for ⇧⇥. */
  grandparent: Task | null
}

/**
 * The inline "new subtask" row. ↵ saves and opens the next sibling, ⇥ moves the
 * draft under the row above, ⇧⇥ moves it out one level, Esc closes it. The
 * hint at the end names the parent, so the indent is never a guess.
 */
export const SubtaskDraftRow = ({
  parent,
  siblings,
  depth,
  grandparent
}: SubtaskDraftRowProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const expansion = useTaskExpansion()
  const [title, setTitle] = useState('')
  if (!tree) return null

  const rowAbove = siblings[siblings.length - 1]

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const trimmed = title.trim()
      if (!trimmed) {
        tree.closeDraft()
        return
      }
      tree.addSubtask(parent.id, trimmed)
      setTitle('')
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (rowAbove && tree.canAddUnder(rowAbove.id)) {
        expansion?.expand(rowAbove.id)
        tree.openDraft(rowAbove.id)
      }
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      if (grandparent) tree.openDraft(grandparent.id)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      tree.closeDraft()
    }
  }

  return (
    <div
      data-testid="subtask-draft-row"
      className={cn(
        'flex items-center gap-1 py-1 pe-3 rounded-e-sm bg-background',
        'ring-1 ring-inset ring-border',
        depth === 1 ? 'ps-6' : 'ps-1'
      )}
    >
      <span className="w-4 shrink-0" aria-hidden="true" />
      <span
        className="size-3.5 shrink-0 rounded-full border-[1.5px] border-dashed border-text-tertiary"
        aria-hidden="true"
      />
      <input
        // The draft opens on a click or a key, so taking focus is the point.
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        // ⇥ and ⇧⇥ unmount this row while it has focus; the blur that follows
        // must not close the draft they just moved.
        onBlur={() => {
          if (!title.trim()) tree.closeDraft(parent.id)
        }}
        placeholder={t('subtaskTree.draftPlaceholder')}
        aria-label={t('subtaskTree.draftLabel', { title: parent.title })}
        className="ms-1 min-w-0 grow bg-transparent text-[13px] font-medium text-foreground outline-none placeholder:text-text-tertiary"
      />
      <span className="max-w-[40%] shrink-0 truncate text-[11px]/3.5 text-text-tertiary">
        {t('subtaskTree.draftIn', { title: parent.title })}
      </span>
    </div>
  )
}
