/**
 * Pure analyzer for the editor's block tree. Identifies which conversion
 * intent the next onChange should fire (turn a checkbox into a task or
 * subtask, finalize a draft taskBlock, wire up a Tab-indented task as a
 * subtask, or unwire a Shift+Tab-promoted subtask). Kept side-effect-free so
 * it can be exhaustively unit-tested.
 *
 * Hierarchy rules:
 *   - 1-level subtask depth: a checkListItem nested directly under a
 *     top-level taskBlock is a subtask candidate. Anything deeper is ignored.
 *   - "parentTaskBlock" tracked during recursion is the *tree* parent (the
 *     ancestor in the document), not the value of the parentTaskId prop.
 */

import { extractInlineText, parseTaskBlockSuffix } from '@memry/shared/task-block'
import { obsidianTaskImportBlocker } from '@memry/shared/obsidian-tasks'

export interface SubtaskCandidate {
  blockId: string
  parentTaskId: string
}

export interface StandaloneCandidate {
  blockId: string
}

export interface DraftTaskBlock {
  blockId: string
  title: string
}

export interface UnindentedTaskBlock {
  blockId: string
  taskId: string
}

export interface DemotedTaskBlock {
  blockId: string
  taskId: string
  newParentTaskId: string
}

export interface TaskIntents {
  subtaskCandidate: SubtaskCandidate | null
  standaloneCandidate: StandaloneCandidate | null
  draftTaskBlock: DraftTaskBlock | null
  unindentedTaskBlocks: UnindentedTaskBlock[]
  demotedTaskBlocks: DemotedTaskBlock[]
  currentTaskIds: Set<string>
}

interface TaskIntentBlock {
  id: string
  type?: string
  props?: {
    taskId?: string
    parentTaskId?: string
    title?: unknown
  }
  content?: unknown
  children?: TaskIntentBlock[]
}

function isTaskBlock(block: TaskIntentBlock): boolean {
  return block?.type === 'taskBlock'
}

function isCheckListItem(block: TaskIntentBlock): boolean {
  return block?.type === 'checkListItem'
}

// A checkbox that already carries a `{task:<id>}` suffix is a persisted task
// (seeded from markdown / synced from the CRDT), NOT a fresh user checkbox.
// Converting it would mint a duplicate DB task and drop the original id, so it
// must never be treated as a conversion candidate.
function hasTaskSuffix(block: TaskIntentBlock): boolean {
  return parseTaskBlockSuffix(extractInlineText(block.content)) !== null
}

// Three Obsidian Tasks constructs Memry cannot rewrite. Appending `{task:<id>}`
// un-anchors the plugin's end-anchored field regexes, and `🆔` / `⛔` name lines
// in files Memry has not read. Declining them leaves the bytes untouched.
//
// Called only where a candidate would otherwise be taken: this runs on every
// editor onChange, and the check parses the line.
function isImportBlocked(block: TaskIntentBlock): boolean {
  return obsidianTaskImportBlocker(extractInlineText(block.content)) !== null
}

export function analyzeTaskIntents(
  blocks: TaskIntentBlock[],
  dismissedBlockIds: Set<string>
): TaskIntents {
  const intents: TaskIntents = {
    subtaskCandidate: null,
    standaloneCandidate: null,
    draftTaskBlock: null,
    unindentedTaskBlocks: [],
    demotedTaskBlocks: [],
    currentTaskIds: new Set<string>()
  }

  // Top-level: any taskBlock with parentTaskId set was un-indented (Shift+Tab)
  for (const b of blocks) {
    if (isTaskBlock(b) && b.props?.taskId && b.props?.parentTaskId) {
      intents.unindentedTaskBlocks.push({
        blockId: b.id,
        taskId: b.props.taskId
      })
    }
  }

  const walk = (list: TaskIntentBlock[], parentTaskBlock: TaskIntentBlock | null): void => {
    for (const b of list) {
      if (isTaskBlock(b) && b.props?.taskId) {
        intents.currentTaskIds.add(b.props.taskId)

        // Tab-indented standalone task → became a child of another taskBlock.
        // The parentTaskId prop is empty/stale and doesn't match the tree
        // ancestor. Wire it up.
        if (parentTaskBlock && parentTaskBlock.props?.taskId) {
          const expected = parentTaskBlock.props.taskId
          if (b.props.parentTaskId !== expected) {
            intents.demotedTaskBlocks.push({
              blockId: b.id,
              taskId: b.props.taskId,
              newParentTaskId: expected
            })
          }
        }

        // 1-level limit: only walk children with parent context if WE are top
        // level. Otherwise pass null so deeper checkboxes don't get marked as
        // subtask candidates of a subtask.
        const passAsParent = parentTaskBlock === null ? b : null
        if (b.children?.length) walk(b.children, passAsParent)
        continue
      }

      if (
        isTaskBlock(b) &&
        !b.props?.taskId &&
        typeof b.props?.title === 'string' &&
        b.props.title.trim() &&
        !intents.draftTaskBlock &&
        !dismissedBlockIds.has(b.id)
      ) {
        intents.draftTaskBlock = {
          blockId: b.id,
          title: b.props.title
        }
      }

      if (isCheckListItem(b) && !dismissedBlockIds.has(b.id) && !hasTaskSuffix(b)) {
        if (parentTaskBlock && parentTaskBlock.props?.taskId) {
          if (!intents.subtaskCandidate && !isImportBlocked(b)) {
            intents.subtaskCandidate = {
              blockId: b.id,
              parentTaskId: parentTaskBlock.props.taskId
            }
          }
        } else if (!intents.standaloneCandidate && !isImportBlocked(b)) {
          intents.standaloneCandidate = { blockId: b.id }
        }
      }

      if (b.children?.length) walk(b.children, null)
    }
  }

  walk(blocks, null)
  return intents
}
