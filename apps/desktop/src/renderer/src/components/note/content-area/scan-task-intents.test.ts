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
})
