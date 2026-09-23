import { describe, it, expect } from 'vitest'
import type { NoteListItem } from '@/hooks/use-notes-query'
import {
  TREE_ROW_HEIGHT,
  countTreeItems,
  flattenTree,
  getAllFolderIds,
  getParentFolderId,
  estimateTreeHeight,
  orderFolderEntries,
  shouldVirtualize,
  type FolderNode,
  type TreeStructure
} from './virtualized-tree-utils'

// ============================================================================
// MOCK FACTORIES
// ============================================================================

const baseDate = new Date(2026, 0, 1)

const createNote = (overrides: Partial<NoteListItem> = {}): NoteListItem => ({
  id: 'note-1',
  path: 'notes/note-1.md',
  title: 'Sample Note',
  created: baseDate,
  modified: baseDate,
  tags: [],
  wordCount: 0,
  ...overrides
})

const createFolder = (overrides: Partial<FolderNode> = {}): FolderNode => ({
  name: 'Folder',
  path: 'Folder',
  children: [],
  notes: [],
  ...overrides
})

const buildSampleTree = (): {
  tree: TreeStructure
  rootNote: NoteListItem
  workNote: NoteListItem
  projectNote1: NoteListItem
  projectNote2: NoteListItem
} => {
  const rootNote = createNote({
    id: 'note-root',
    path: 'notes/root.md',
    title: 'Root Note'
  })

  const projectNote1 = createNote({
    id: 'note-project-1',
    path: 'notes/Work/Project/note-1.md',
    title: 'Project Note 1'
  })

  const projectNote2 = createNote({
    id: 'note-project-2',
    path: 'notes/Work/Project/note-2.md',
    title: 'Project Note 2'
  })

  const workNote = createNote({
    id: 'note-work-1',
    path: 'notes/Work/note-work.md',
    title: 'Work Note'
  })

  const projectFolder = createFolder({
    name: 'Project',
    path: 'Work/Project',
    notes: [projectNote1, projectNote2]
  })

  const workFolder = createFolder({
    name: 'Work',
    path: 'Work',
    children: [projectFolder],
    notes: [workNote]
  })

  const personalFolder = createFolder({
    name: 'Personal',
    path: 'Personal'
  })

  const tree: TreeStructure = {
    folders: [workFolder, personalFolder],
    rootNotes: [rootNote]
  }

  return { tree, rootNote, workNote, projectNote1, projectNote2 }
}

// ============================================================================
// TESTS
// ============================================================================

describe('virtualized-tree-utils', () => {
  describe('T197: countTreeItems, flattenTree, getAllFolderIds', () => {
    it('counts folders and notes across the tree', () => {
      const { tree } = buildSampleTree()
      expect(countTreeItems(tree)).toBe(7)
    })

    it('flattens expanded folders into visible items', () => {
      const { tree } = buildSampleTree()
      const expandedIds = new Set(['folder-Work', 'folder-Work/Project'])
      const items = flattenTree(tree, expandedIds)

      expect(items.map((item) => item.id)).toEqual([
        'folder-Work',
        'folder-Work/Project',
        'note-project-1',
        'note-project-2',
        'note-work-1',
        'folder-Personal',
        'note-root'
      ])

      expect(items[0]).toMatchObject({
        id: 'folder-Work',
        type: 'folder',
        level: 0,
        isExpanded: true,
        hasChildren: true,
        isLast: false
      })

      expect(items[1]).toMatchObject({
        id: 'folder-Work/Project',
        type: 'folder',
        level: 1,
        isExpanded: true,
        hasChildren: true,
        isLast: false
      })

      expect(items[3]).toMatchObject({
        id: 'note-project-2',
        type: 'note',
        level: 2,
        isLast: true
      })

      expect(items[6]).toMatchObject({
        id: 'note-root',
        type: 'note',
        level: 0,
        isLast: true
      })
    })

    it('flattens only folders and root notes when collapsed', () => {
      const { tree } = buildSampleTree()
      const items = flattenTree(tree, new Set())

      expect(items.map((item) => item.id)).toEqual(['folder-Work', 'folder-Personal', 'note-root'])

      expect(items[0]).toMatchObject({
        id: 'folder-Work',
        type: 'folder',
        isExpanded: false,
        hasChildren: true
      })
    })

    it('collects all folder IDs in the tree', () => {
      const { tree } = buildSampleTree()
      expect(getAllFolderIds(tree)).toEqual([
        'folder-Work',
        'folder-Work/Project',
        'folder-Personal'
      ])
    })
  })

  describe('notesFirst ordering', () => {
    const expandAll = new Set(['folder-Work', 'folder-Work/Project', 'folder-Personal'])
    const rows = (tree: TreeStructure) =>
      flattenTree(tree, expandAll).map((item) => `${item.id}${item.isLast ? ' (last)' : ''}`)

    // The tree every earlier build drew, pinned so notes-first cannot leak in
    // through an absent flag.
    it('keeps folders before notes at every level when the flag is absent or off', () => {
      const { tree } = buildSampleTree()
      const expected = [
        'folder-Work',
        'folder-Work/Project',
        'note-project-1',
        'note-project-2 (last)',
        'note-work-1 (last)',
        'folder-Personal',
        'note-root (last)'
      ]

      expect(rows(tree)).toEqual(expected)
      expect(rows({ ...tree, notesFirst: false })).toEqual(expected)
    })

    it('puts notes before folders at every level, the vault root included', () => {
      const { tree } = buildSampleTree()

      expect(rows({ ...tree, notesFirst: true })).toEqual([
        'note-root',
        'folder-Work',
        'note-work-1',
        'folder-Work/Project (last)',
        'note-project-1',
        'note-project-2 (last)',
        'folder-Personal (last)'
      ])
    })

    // A level with only one group has no ordering to flip; its last row is
    // still the last row.
    it('marks the last row of a single-group level either way', () => {
      const { tree } = buildSampleTree()
      const notesOnly: TreeStructure = { folders: [], rootNotes: tree.rootNotes, notesFirst: true }
      const foldersOnly: TreeStructure = { folders: tree.folders, rootNotes: [], notesFirst: true }

      expect(flattenTree(notesOnly, new Set()).map((item) => item.isLast)).toEqual([true])
      expect(flattenTree(foldersOnly, new Set()).map((item) => item.isLast)).toEqual([false, true])
    })

    it('orders one level and keeps each group in its given order', () => {
      const { tree } = buildSampleTree()
      const [work, personal] = tree.folders
      const [workNote] = work.notes
      const ids = (notesFirst: boolean) =>
        orderFolderEntries(tree.folders, [tree.rootNotes[0], workNote], notesFirst).map((entry) =>
          entry.type === 'folder' ? entry.folder.path : entry.note.id
        )

      expect(ids(false)).toEqual([work.path, personal.path, 'note-root', 'note-work-1'])
      expect(ids(true)).toEqual(['note-root', 'note-work-1', work.path, personal.path])
    })
  })

  describe('T198: getParentFolderId, estimateTreeHeight, shouldVirtualize', () => {
    it('returns parent folder IDs for folder and note items', () => {
      const { tree } = buildSampleTree()
      const expandedIds = new Set(['folder-Work', 'folder-Work/Project'])
      const items = flattenTree(tree, expandedIds)

      const workFolder = items.find((item) => item.id === 'folder-Work')
      const projectFolder = items.find((item) => item.id === 'folder-Work/Project')
      const projectNote = items.find((item) => item.id === 'note-project-1')
      const rootNote = items.find((item) => item.id === 'note-root')

      expect(workFolder).toBeDefined()
      expect(projectFolder).toBeDefined()
      expect(projectNote).toBeDefined()
      expect(rootNote).toBeDefined()

      expect(getParentFolderId(workFolder!)).toBeNull()
      expect(getParentFolderId(projectFolder!)).toBe('folder-Work')
      expect(getParentFolderId(projectNote!)).toBe('folder-Work/Project')
      expect(getParentFolderId(rootNote!)).toBeNull()
    })

    it('estimates height based on row count', () => {
      expect(estimateTreeHeight(5)).toBe(5 * TREE_ROW_HEIGHT)
    })

    it('enables virtualization at the threshold', () => {
      const makeTree = (count: number): TreeStructure => ({
        folders: [],
        rootNotes: Array.from({ length: count }, (_, index) =>
          createNote({
            id: `note-${index}`,
            path: `notes/note-${index}.md`
          })
        )
      })

      expect(shouldVirtualize(makeTree(99))).toBe(false)
      expect(shouldVirtualize(makeTree(100))).toBe(true)
    })
  })
})
