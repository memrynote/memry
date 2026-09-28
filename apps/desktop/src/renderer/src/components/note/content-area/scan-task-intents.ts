/**
 * Pure analyzer for the editor's block tree. Identifies which conversion
 * intent the next onChange should fire (turn a checkbox into a task or
 * subtask, finalize a draft taskBlock, wire up a Tab-indented task as a
 * subtask, or unwire a Shift+Tab-promoted subtask). Kept side-effect-free so
 * it can be exhaustively unit-tested.
 *
 * A checkbox with `plain: true` is one the user keeps as a checkbox
 * (`@memry/shared/plain-checkbox`). It is never a candidate, and a new
 * checkbox that continues a plain list is made plain rather than converted.
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
  /**
   * Checkboxes that continue a plain checklist: the one right above them (or,
   * for a first child, the one they are nested under) is plain. They are made
   * plain instead of being converted, which is what makes Enter in a plain
   * list give another plain checkbox.
   */
  plainByContext: string[]
  /**
   * A checkbox typed in this editor with nothing on it yet. It is shown as a
   * draft taskBlock right away (no row created); the draft path creates the
   * task once a title is typed.
   */
  emptyCheckbox: { blockId: string; parentTaskId: string } | null
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
    plain?: unknown
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

// A checkbox the user keeps as one. Never a conversion candidate.
function isPlainCheckbox(block: TaskIntentBlock | null | undefined): boolean {
  return !!block && isCheckListItem(block) && block.props?.plain === true
}

// A checkbox that already carries a `{task:<id>}` suffix is a persisted task
// (seeded from markdown / synced from the CRDT), NOT a fresh user checkbox.
// Converting it would mint a duplicate DB task and drop the original id, so it
// must never be treated as a conversion candidate.
function hasTaskSuffix(block: TaskIntentBlock): boolean {
  return parseTaskBlockSuffix(extractInlineText(block.content)) !== null
}

// A checkbox with nothing typed on it yet is not a task. Taken as a candidate,
// `convertCheckboxToTask` rewrites it into a `taskBlock` with an empty title,
// `tasks:create` is refused for exactly that empty title, and the block is left
// holding `taskId: ''` with every control on it dead (#2271). The line becomes
// a candidate again on the first character the user types.
function hasCheckboxText(block: TaskIntentBlock): boolean {
  return extractInlineText(block.content).trim().length > 0
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

export interface TaskIntentOptions {
  /**
   * Blocks the note opened with. A checkbox already in the file when the note
   * opened converts like any other, even under a plain one: only a checkbox
   * made in this editor continues a plain list.
   */
  openedBlockIds?: ReadonlySet<string>
}

export function analyzeTaskIntents(
  blocks: TaskIntentBlock[],
  dismissedBlockIds: Set<string>,
  options: TaskIntentOptions = {}
): TaskIntents {
  const intents: TaskIntents = {
    subtaskCandidate: null,
    standaloneCandidate: null,
    plainByContext: [],
    emptyCheckbox: null,
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

  const walk = (
    list: TaskIntentBlock[],
    parentTaskBlock: TaskIntentBlock | null,
    parentIsPlain = false
  ): void => {
    for (const [index, b] of list.entries()) {
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

      // Checked before the candidate arms below, and for empty checkboxes too:
      // Enter in a plain list makes an empty one, and it has to be plain before
      // the first character lands, not 600ms after.
      const continuesPlainList =
        !options.openedBlockIds?.has(b.id) &&
        (index > 0 ? isPlainCheckbox(list[index - 1]) : parentIsPlain)
      if (
        isCheckListItem(b) &&
        !isPlainCheckbox(b) &&
        continuesPlainList &&
        !dismissedBlockIds.has(b.id) &&
        !hasTaskSuffix(b)
      ) {
        intents.plainByContext.push(b.id)
      } else if (
        isCheckListItem(b) &&
        !isPlainCheckbox(b) &&
        !dismissedBlockIds.has(b.id) &&
        !hasTaskSuffix(b) &&
        hasCheckboxText(b)
      ) {
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
      } else if (
        isCheckListItem(b) &&
        !isPlainCheckbox(b) &&
        !intents.emptyCheckbox &&
        !options.openedBlockIds?.has(b.id) &&
        !dismissedBlockIds.has(b.id) &&
        !hasTaskSuffix(b) &&
        !hasCheckboxText(b)
      ) {
        intents.emptyCheckbox = {
          blockId: b.id,
          parentTaskId: parentTaskBlock?.props?.taskId ?? ''
        }
      }

      if (b.children?.length) walk(b.children, null, isPlainCheckbox(b))
    }
  }

  walk(blocks, null)
  return intents
}
