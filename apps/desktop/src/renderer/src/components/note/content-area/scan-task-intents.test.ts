/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { analyzeTaskIntents } from './scan-task-intents'

const cl = (id: string, text: string, isChecked = false, children: any[] = []): any => ({
  id,
  type: 'checkListItem',
  props: { isChecked },
  content: [{ type: 'text', text, styles: {} }],
  children
})

const tb = (
  id: string,
  taskId: string,
  title = 'task',
  parentTaskId = '',
  children: any[] = []
): any => ({
  id,
  type: 'taskBlock',
  props: { taskId, title, checked: false, parentTaskId },
  content: undefined,
  children
})

const para = (id: string, text = ''): any => ({
  id,
  type: 'paragraph',
  props: {},
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children: []
})

describe('analyzeTaskIntents', () => {
  describe('empty checkbox', () => {
    it('reports a freshly typed empty checkbox so it can show as a draft task', () => {
      const intents = analyzeTaskIntents([cl('cl1', '')], new Set())
      expect(intents.emptyCheckbox).toEqual({ blockId: 'cl1', parentTaskId: '' })
      expect(intents.standaloneCandidate).toBeNull()
    })

    it('carries the parent task id for an empty checkbox under a task', () => {
      const intents = analyzeTaskIntents(
        [tb('tb1', 'task-1', 'Parent', '', [cl('cl1', '')])],
        new Set()
      )
      expect(intents.emptyCheckbox).toEqual({ blockId: 'cl1', parentTaskId: 'task-1' })
    })

    it('leaves empty checkboxes the note opened with alone', () => {
      const intents = analyzeTaskIntents([cl('cl1', '')], new Set(), {
        openedBlockIds: new Set(['cl1'])
      })
      expect(intents.emptyCheckbox).toBeNull()
    })

    it('does not draft an empty checkbox that continues a plain list', () => {
      const plain = { ...cl('p1', 'plain'), props: { isChecked: false, plain: true } }
      const intents = analyzeTaskIntents([plain, cl('cl1', '')], new Set())
      expect(intents.emptyCheckbox).toBeNull()
      expect(intents.plainByContext).toEqual(['cl1'])
    })
  })

  describe('top-level checkListItem', () => {
    it('should mark a top-level checkbox as standalone task candidate', () => {
      // #given
      const blocks = [cl('cl1', 'Buy milk')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
      expect(result.subtaskCandidate).toBeNull()
    })

    // #2271 — an empty checkbox taken as a candidate is rewritten into a
    // taskBlock whose title is empty, `tasks:create` refuses that title, and
    // the block is stranded on `taskId: ''`. The line the user is still
    // typing is not a task yet.
    it('should not mark a checkbox with no text as a candidate', () => {
      // #given a `- [ ] ` the user has typed nothing on, top level and nested
      const blocks = [tb('tb1', 'task-1'), cl('cl1', ''), cl('cl2', '   ')]
      blocks[0].children = [cl('cl3', '')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toBeNull()
      expect(result.subtaskCandidate).toBeNull()
    })

    it('should mark the checkbox as a candidate as soon as it has text', () => {
      // #given the same line, one keystroke later
      const blocks = [cl('cl1', 'B')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
    })

    it('should ignore dismissed checkboxes', () => {
      // #given
      const blocks = [cl('cl1', 'Buy milk')]
      const dismissed = new Set<string>(['cl1'])

      // #when
      const result = analyzeTaskIntents(blocks, dismissed)

      // #then
      expect(result.standaloneCandidate).toBeNull()
    })
  })

  describe('existing {task:} checkboxes (already-persisted tasks)', () => {
    it('should NOT mark a top-level checkbox carrying a {task:} suffix as a standalone candidate', () => {
      // #given - a persisted task that seeded into the doc as a raw checkbox
      const blocks = [cl('cl1', 'Buy milk {task:abc-123}')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then - converting it would create a duplicate task, so skip it
      expect(result.standaloneCandidate).toBeNull()
      expect(result.subtaskCandidate).toBeNull()
    })

    it('should NOT mark a nested {task:} checkbox under a taskBlock as a subtask candidate', () => {
      // #given
      const blocks = [tb('tb1', 'task-1', 'Plan trip', '', [cl('cl1', 'Book flight {task:sub-9}')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.subtaskCandidate).toBeNull()
      expect(result.standaloneCandidate).toBeNull()
    })

    it('should still mark a plain checkbox (no suffix) as a candidate', () => {
      // #given
      const blocks = [cl('cl1', 'Buy milk')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
    })
  })

  describe('Obsidian Tasks lines Memry must not rewrite', () => {
    it('should decline a top-level checkbox carrying a block link', () => {
      // #given - appending `{task:<id>}` would move `^ref-1` off the end of the line
      const blocks = [cl('cl1', 'Buy milk ^ref-1')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toBeNull()
      expect(result.subtaskCandidate).toBeNull()
    })

    it('should decline a top-level checkbox carrying a task id', () => {
      // #given - the id is a graph edge other files point at
      const blocks = [cl('cl1', 'Buy milk 🆔 abc123')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toBeNull()
    })

    it('should decline a top-level checkbox carrying a dependency', () => {
      // #given
      const blocks = [cl('cl1', 'Buy milk ⛔ abc123')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toBeNull()
    })

    it('should decline a nested blocked checkbox as a subtask candidate', () => {
      // #given
      const blocks = [tb('tb1', 'task-1', 'Plan trip', '', [cl('cl1', 'Book flight 🆔 flight-1')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.subtaskCandidate).toBeNull()
      expect(result.standaloneCandidate).toBeNull()
    })

    it('should still pick an ordinary checkbox that carries plugin fields', () => {
      // #given - a due date and a priority are importable, not blockers
      const blocks = [cl('cl1', 'Buy milk 📅 2026-01-01 ⏫')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
    })

    it('should pick the next unblocked checkbox after a blocked one', () => {
      // #given
      const blocks = [cl('cl1', 'Buy milk ^ref-1'), cl('cl2', 'Buy bread')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl2' })
    })
  })

  describe('checkListItem nested under taskBlock', () => {
    it('should mark a nested checkbox under a top-level taskBlock as subtask candidate', () => {
      // #given
      const blocks = [tb('tb1', 'task-1', 'Plan trip', '', [cl('cl1', 'Book flight')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.subtaskCandidate).toEqual({
        blockId: 'cl1',
        parentTaskId: 'task-1'
      })
      expect(result.standaloneCandidate).toBeNull()
    })

    it('should NOT mark a nested checkbox under a subtask taskBlock as subtask candidate (1-level limit)', () => {
      // #given - subtask (parentTaskId set) with a checkbox under it
      const subtask = tb('tb-sub', 'task-sub', 'Sub', 'task-1', [cl('cl1', 'Deeper')])
      const blocks = [tb('tb1', 'task-1', 'Top', '', [subtask])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then - the deeper checkbox should fall through to standalone (or be ignored)
      expect(result.subtaskCandidate).toBeNull()
    })

    it('should prefer subtask over standalone when both exist', () => {
      // #given
      const blocks = [
        cl('cl-top', 'Standalone'),
        tb('tb1', 'task-1', 'Plan', '', [cl('cl-nested', 'Sub')])
      ]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.subtaskCandidate).not.toBeNull()
      expect(result.subtaskCandidate?.blockId).toBe('cl-nested')
    })
  })

  describe('draft taskBlock detection', () => {
    it('should detect a taskBlock with title but no taskId as draft', () => {
      // #given
      const blocks = [tb('tb1', '', 'Half-typed')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.draftTaskBlock).toEqual({ blockId: 'tb1', title: 'Half-typed' })
    })

    it('should not detect a draft taskBlock with empty title', () => {
      // #given
      const blocks = [tb('tb1', '', '')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.draftTaskBlock).toBeNull()
    })
  })

  describe('currentTaskIds collection', () => {
    it('should collect task IDs from top-level taskBlocks', () => {
      // #given
      const blocks = [tb('tb1', 'task-a'), tb('tb2', 'task-b')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.currentTaskIds).toEqual(new Set(['task-a', 'task-b']))
    })

    it('should collect task IDs from nested taskBlocks', () => {
      // #given
      const blocks = [tb('tb1', 'task-a', 'Top', '', [tb('tb2', 'task-b', 'Sub', 'task-a')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.currentTaskIds).toEqual(new Set(['task-a', 'task-b']))
    })
  })

  describe('un-indented (Shift+Tab) detection', () => {
    it('should detect a top-level taskBlock with parentTaskId still set as un-indented', () => {
      // #given - subtask was promoted but parentTaskId prop is stale
      const blocks = [tb('tb1', 'task-a', 'Parent', ''), tb('tb2', 'task-b', 'Was sub', 'task-a')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.unindentedTaskBlocks).toContainEqual({ blockId: 'tb2', taskId: 'task-b' })
    })

    it('should NOT mark a properly nested taskBlock as un-indented', () => {
      // #given
      const blocks = [tb('tb1', 'task-a', 'Parent', '', [tb('tb2', 'task-b', 'Sub', 'task-a')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.unindentedTaskBlocks).toEqual([])
    })
  })

  describe('Tab-indented (demote via Tab) detection', () => {
    it('should detect a nested taskBlock whose parentTaskId is empty (Tab indented standalone task)', () => {
      // #given - tb2 is nested under tb1 in the tree but its parentTaskId prop is empty
      const blocks = [tb('tb1', 'task-a', 'Parent', '', [tb('tb2', 'task-b', 'Was top-level', '')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.demotedTaskBlocks).toContainEqual({
        blockId: 'tb2',
        taskId: 'task-b',
        newParentTaskId: 'task-a'
      })
    })

    it('should detect a nested taskBlock whose parentTaskId disagrees with its tree parent', () => {
      // #given - tb2 is nested under tb1 but its parentTaskId points elsewhere (stale)
      const blocks = [tb('tb1', 'task-a', 'Parent', '', [tb('tb2', 'task-b', 'Stale', 'task-z')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.demotedTaskBlocks).toContainEqual({
        blockId: 'tb2',
        taskId: 'task-b',
        newParentTaskId: 'task-a'
      })
    })

    it('should NOT mark a correctly-wired nested taskBlock as needing wiring', () => {
      // #given
      const blocks = [tb('tb1', 'task-a', 'Parent', '', [tb('tb2', 'task-b', 'Sub', 'task-a')])]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.demotedTaskBlocks).toEqual([])
    })

    it('should NOT mark a top-level taskBlock as demoted', () => {
      // #given
      const blocks = [tb('tb1', 'task-a', 'Top', '')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.demotedTaskBlocks).toEqual([])
    })
  })

  describe('mixed structures', () => {
    it('should handle paragraphs interspersed with task blocks', () => {
      // #given
      const blocks = [
        para('p1', 'Hello'),
        tb('tb1', 'task-a', 'Plan', '', [cl('cl1', 'Step 1')]),
        para('p2', 'World')
      ]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.subtaskCandidate?.blockId).toBe('cl1')
      expect(result.currentTaskIds).toEqual(new Set(['task-a']))
    })

    it('should not consider checkboxes nested under non-task-block parents', () => {
      // #given - checkbox nested under a paragraph (uncommon but possible)
      const blocks = [{ ...para('p1', 'Hello'), children: [cl('cl1', 'Hidden')] }]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then - this checkbox should be a standalone candidate (no taskBlock parent)
      expect(result.standaloneCandidate?.blockId).toBe('cl1')
      expect(result.subtaskCandidate).toBeNull()
    })
  })

  describe('plain checkboxes', () => {
    const plain = (id: string, text: string, children: any[] = []): any => ({
      ...cl(id, text, false, children),
      props: { checked: false, plain: true }
    })

    it('never offers a plain checkbox, top level or under a task', () => {
      // #given
      const blocks = [
        plain('p1', 'Passport'),
        tb('tb1', 'task-1', 'Trip', '', [plain('p2', 'Sock')])
      ]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.standaloneCandidate).toBeNull()
      expect(result.subtaskCandidate).toBeNull()
      expect(result.plainByContext).toEqual([])
    })

    it('makes a checkbox that continues a plain list plain, even before it has text', () => {
      // #given Enter at the end of a plain list, then one more typed line
      const blocks = [plain('p1', 'Passport'), cl('cl1', ''), cl('cl2', 'Charger')]
      // and the checkbox Tab put under a plain one
      blocks.push(plain('p2', 'Clothes', [cl('cl3', 'Socks')]))

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then only the ones directly after a plain checkbox, or first under one
      expect(result.plainByContext).toEqual(['cl1', 'cl3'])
      // cl2 follows cl1, which is not plain yet in this snapshot
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl2' })
    })

    it('converts a checkbox the note opened with, even under a plain one', () => {
      // #given a line added under a plain list outside the app
      const blocks = [plain('p1', 'Passport'), cl('cl1', 'Charger')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set(), {
        openedBlockIds: new Set(['p1', 'cl1'])
      })

      // #then the open rule wins: every unmarked checkbox becomes a task
      expect(result.plainByContext).toEqual([])
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
    })

    it('leaves a checkbox after a task or a paragraph to become a task', () => {
      // #given
      const blocks = [tb('tb1', 'task-1'), cl('cl1', 'Next'), para('x', 'text'), cl('cl2', 'Other')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set())

      // #then
      expect(result.plainByContext).toEqual([])
      expect(result.standaloneCandidate).toEqual({ blockId: 'cl1' })
    })

    it('does not claim a remote or dismissed checkbox, or a persisted task line', () => {
      // #given
      const blocks = [plain('p1', 'A'), cl('cl1', 'B'), plain('p2', 'C'), cl('cl2', 'D {task:t1}')]

      // #when
      const result = analyzeTaskIntents(blocks, new Set(['cl1']))

      // #then
      expect(result.plainByContext).toEqual([])
    })
  })
})
