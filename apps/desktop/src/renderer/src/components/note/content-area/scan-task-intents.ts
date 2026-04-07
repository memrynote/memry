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

/* eslint-disable @typescript-eslint/no-explicit-any */

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

function isTaskBlock(block: any): boolean {
  return block?.type === 'taskBlock'
}

function isCheckListItem(block: any): boolean {
  return block?.type === 'checkListItem'
}

export function analyzeTaskIntents(blocks: any[], dismissedBlockIds: Set<string>): TaskIntents {
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

  const walk = (list: any[], parentTaskBlock: any | null): void => {
    for (const b of list) {
      if (isTaskBlock(b) && b.props?.taskId) {
        intents.currentTaskIds.add(b.props.taskId as string)

        // Tab-indented standalone task → became a child of another taskBlock.
        // The parentTaskId prop is empty/stale and doesn't match the tree
        // ancestor. Wire it up.
        if (parentTaskBlock && parentTaskBlock.props?.taskId) {
          const expected = parentTaskBlock.props.taskId as string
          if (b.props.parentTaskId !== expected) {
            intents.demotedTaskBlocks.push({
              blockId: b.id,
              taskId: b.props.taskId as string,
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
          title: b.props.title as string
        }
      }

      if (isCheckListItem(b) && !dismissedBlockIds.has(b.id)) {
        if (parentTaskBlock && parentTaskBlock.props?.taskId) {
          if (!intents.subtaskCandidate) {
            intents.subtaskCandidate = {
              blockId: b.id,
              parentTaskId: parentTaskBlock.props.taskId as string
            }
          }
        } else if (!intents.standaloneCandidate) {
          intents.standaloneCandidate = { blockId: b.id }
        }
      }

      if (b.children?.length) walk(b.children, null)
    }
  }

  walk(blocks, null)
  return intents
}
