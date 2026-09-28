/**
 * Writes a bound frame's category onto a card's note or task (#2483).
 *
 * Every write goes through the same paths the note and task editors use —
 * `notes.update` for note tags, `properties.set` for note properties,
 * `tasks.update` for task tags — so sync, the index and every open view see an
 * ordinary edit. Nothing here is canvas-specific data.
 *
 * Each successful write hands back its inverse. The inverse is computed
 * against the entity as it is when undo runs, not a snapshot of the whole tag
 * list or property record from before: an edit made in between (another tag
 * added in the note tab, say) must survive the undo.
 *
 * @module pages/canvas/canvas-frame-categorize
 */

import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import { notesService } from '@/services/notes-service'
import { propertiesService } from '@/services/properties-service'
import { tasksService } from '@/services/tasks-service'
import {
  UNCHANGED,
  addPropertyValue,
  addTag,
  categorizeSkipReason,
  removePropertyValue,
  removeTag,
  type CategorizeSkipReason,
  type FrameBinding
} from './canvas-frame-binding'

export interface CategorizeTarget {
  entityType: CanvasEntityType
  entityId: string
}

export type CategorizeOutcome =
  | { status: 'applied'; revert: () => Promise<void> }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: CategorizeSkipReason }

type Direction = 'add' | 'remove'

function opposite(direction: Direction): Direction {
  return direction === 'add' ? 'remove' : 'add'
}

async function writeNoteTags(noteId: string, tag: string, direction: Direction): Promise<boolean> {
  const note = await notesService.get(noteId)
  if (!note) throw new Error(`Note not found: ${noteId}`)
  const next = direction === 'add' ? addTag(note.tags, tag) : removeTag(note.tags, tag)
  if (!next) return false
  const result = await notesService.update({ id: noteId, tags: next })
  if (!result.success) throw new Error(result.error ?? 'Failed to update note tags')
  return true
}

async function writeTaskTags(taskId: string, tag: string, direction: Direction): Promise<boolean> {
  const task = await tasksService.get(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  const tags = task.tags ?? []
  const next = direction === 'add' ? addTag(tags, tag) : removeTag(tags, tag)
  if (!next) return false
  const result = await tasksService.update({ id: taskId, tags: next })
  if (!result.success) throw new Error(result.error ?? 'Failed to update task tags')
  return true
}

/**
 * One property of a note, written through the full-record setter. The record
 * is read fresh from the index right before the write, the same way the
 * properties panel builds it, so no other property is touched.
 */
async function writeNoteProperty(
  noteId: string,
  binding: Extract<FrameBinding, { kind: 'property' }>,
  direction: Direction
): Promise<boolean> {
  const current = await propertiesService.get(noteId)
  const record: Record<string, unknown> = {}
  for (const property of current) record[property.name] = property.value
  const value =
    direction === 'add'
      ? addPropertyValue(record[binding.property], binding)
      : removePropertyValue(record[binding.property], binding)
  if (value === UNCHANGED) return false
  if (value === null) delete record[binding.property]
  else record[binding.property] = value
  const result = await propertiesService.set(noteId, record)
  if (!result.success) throw new Error(result.error ?? 'Failed to update note property')
  return true
}

async function write(
  target: CategorizeTarget,
  binding: FrameBinding,
  direction: Direction
): Promise<boolean> {
  if (binding.kind === 'tag') {
    return target.entityType === 'task'
      ? writeTaskTags(target.entityId, binding.tag, direction)
      : writeNoteTags(target.entityId, binding.tag, direction)
  }
  return writeNoteProperty(target.entityId, binding, direction)
}

async function run(
  target: CategorizeTarget,
  binding: FrameBinding,
  direction: Direction
): Promise<CategorizeOutcome> {
  const reason = categorizeSkipReason(target.entityType, binding)
  if (reason) return { status: 'skipped', reason }
  const changed = await write(target, binding, direction)
  if (!changed) return { status: 'unchanged' }
  return {
    status: 'applied',
    revert: async () => {
      await write(target, binding, opposite(direction))
    }
  }
}

/** Puts the frame's tag or property value on the card's entity. Throws on a failed write. */
export function applyFrameBinding(
  target: CategorizeTarget,
  binding: FrameBinding
): Promise<CategorizeOutcome> {
  return run(target, binding, 'add')
}

/** Takes the frame's tag or property value off the card's entity. Throws on a failed write. */
export function removeFrameBinding(
  target: CategorizeTarget,
  binding: FrameBinding
): Promise<CategorizeOutcome> {
  return run(target, binding, 'remove')
}
