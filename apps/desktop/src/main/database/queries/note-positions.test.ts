/**
 * Note Positions Query Tests
 *
 * Tests for the note_positions table queries used for
 * sidebar drag-drop reordering functionality.
 *
 * @module main/database/queries/note-positions.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  getNotePosition,
  getNotesInFolder,
  getNextPositionInFolder,
  setNotePosition,
  reorderNotesInFolder,
  deleteNotePosition,
  moveNoteToFolder,
  insertNoteAtPosition,
  getAllNotePositions,
  placeNewItemAtTop,
  carryPositionToPath,
  carryFolderPositions,
  dropFolderPositions
} from './note-positions'

describe('note-positions queries', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  // =========================================================================
  // getNotePosition
  // =========================================================================
  describe('getNotePosition', () => {
    it('should return position for existing note path', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/test-note.md', '', 5)

      // Act
      const result = getNotePosition(testDb.db, 'notes/test-note.md')

      // Assert
      expect(result).toBeDefined()
      expect(result?.path).toBe('notes/test-note.md')
      expect(result?.folderPath).toBe('')
      expect(result?.position).toBe(5)
    })

    it('should return undefined for non-existent path', () => {
      // Act
      const result = getNotePosition(testDb.db, 'notes/nonexistent.md')

      // Assert
      expect(result).toBeUndefined()
    })
  })

  // =========================================================================
  // getNotesInFolder
  // =========================================================================
  describe('getNotesInFolder', () => {
    it('should return notes sorted by position ascending', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note-c.md', '', 2)
      setNotePosition(testDb.db, 'notes/note-a.md', '', 0)
      setNotePosition(testDb.db, 'notes/note-b.md', '', 1)

      // Act
      const result = getNotesInFolder(testDb.db, '')

      // Assert
      expect(result).toHaveLength(3)
      expect(result[0].path).toBe('notes/note-a.md')
      expect(result[0].position).toBe(0)
      expect(result[1].path).toBe('notes/note-b.md')
      expect(result[1].position).toBe(1)
      expect(result[2].path).toBe('notes/note-c.md')
      expect(result[2].position).toBe(2)
    })

    it('should return empty array for empty folder', () => {
      // Act
      const result = getNotesInFolder(testDb.db, 'empty-folder')

      // Assert
      expect(result).toEqual([])
    })

    it('should only return notes in specified folder', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/root.md', '', 0)
      setNotePosition(testDb.db, 'notes/work/task.md', 'work', 0)
      setNotePosition(testDb.db, 'notes/work/project.md', 'work', 1)
      setNotePosition(testDb.db, 'notes/personal/diary.md', 'personal', 0)

      // Act
      const workNotes = getNotesInFolder(testDb.db, 'work')
      const rootNotes = getNotesInFolder(testDb.db, '')

      // Assert
      expect(workNotes).toHaveLength(2)
      expect(workNotes[0].path).toBe('notes/work/task.md')
      expect(workNotes[1].path).toBe('notes/work/project.md')

      expect(rootNotes).toHaveLength(1)
      expect(rootNotes[0].path).toBe('notes/root.md')
    })
  })

  // =========================================================================
  // getNextPositionInFolder
  // =========================================================================
  describe('getNextPositionInFolder', () => {
    it('should return 0 for empty folder', () => {
      // Act
      const result = getNextPositionInFolder(testDb.db, 'empty-folder')

      // Assert
      expect(result).toBe(0)
    })

    it('should return max+1 for folder with notes', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/work/note-1.md', 'work', 0)
      setNotePosition(testDb.db, 'notes/work/note-2.md', 'work', 1)
      setNotePosition(testDb.db, 'notes/work/note-3.md', 'work', 5)

      const result = getNextPositionInFolder(testDb.db, 'work')

      expect(result).toBe(6)
    })

    it('should handle root folder correctly', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/root-1.md', '', 0)
      setNotePosition(testDb.db, 'notes/root-2.md', '', 2)

      // Act
      const result = getNextPositionInFolder(testDb.db, '')

      // Assert
      expect(result).toBe(3)
    })
  })

  // =========================================================================
  // setNotePosition
  // =========================================================================
  describe('setNotePosition', () => {
    it('should insert new position record', () => {
      // Act
      setNotePosition(testDb.db, 'notes/new-note.md', 'folder', 3)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/new-note.md')
      expect(result).toBeDefined()
      expect(result?.folderPath).toBe('folder')
      expect(result?.position).toBe(3)
    })

    it('should update existing position record', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note.md', 'old-folder', 0)

      // Act
      setNotePosition(testDb.db, 'notes/note.md', 'new-folder', 5)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/note.md')
      expect(result?.folderPath).toBe('new-folder')
      expect(result?.position).toBe(5)
    })

    it('should handle special characters in path', () => {
      // Act
      setNotePosition(testDb.db, 'notes/folder/note with spaces & symbols!.md', 'folder', 0)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/folder/note with spaces & symbols!.md')
      expect(result).toBeDefined()
    })
  })

  // =========================================================================
  // reorderNotesInFolder
  // =========================================================================
  describe('reorderNotesInFolder', () => {
    it('should set positions based on array order', () => {
      setNotePosition(testDb.db, 'notes/note-a.md', '', 5)
      setNotePosition(testDb.db, 'notes/note-b.md', '', 2)
      setNotePosition(testDb.db, 'notes/note-c.md', '', 8)

      reorderNotesInFolder(testDb.db, '', ['notes/note-b.md', 'notes/note-c.md', 'notes/note-a.md'])

      // Assert
      const notes = getNotesInFolder(testDb.db, '')
      expect(notes[0].path).toBe('notes/note-b.md')
      expect(notes[0].position).toBe(0)
      expect(notes[1].path).toBe('notes/note-c.md')
      expect(notes[1].position).toBe(1)
      expect(notes[2].path).toBe('notes/note-a.md')
      expect(notes[2].position).toBe(2)
    })

    it('should handle empty array', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note.md', '', 0)

      // Act
      reorderNotesInFolder(testDb.db, '', [])

      const result = getNotePosition(testDb.db, 'notes/note.md')
      expect(result?.position).toBe(0)
    })

    it('should create positions for notes without existing positions', () => {
      reorderNotesInFolder(testDb.db, 'work', ['notes/work/new-1.md', 'notes/work/new-2.md'])

      // Assert
      const notes = getNotesInFolder(testDb.db, 'work')
      expect(notes).toHaveLength(2)
      expect(notes[0].path).toBe('notes/work/new-1.md')
      expect(notes[1].path).toBe('notes/work/new-2.md')
    })
  })

  // =========================================================================
  // deleteNotePosition
  // =========================================================================
  describe('deleteNotePosition', () => {
    it('should delete existing position', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/to-delete.md', '', 0)

      // Act
      const result = deleteNotePosition(testDb.db, 'notes/to-delete.md')

      // Assert
      expect(result).toBe(true)
      expect(getNotePosition(testDb.db, 'notes/to-delete.md')).toBeUndefined()
    })

    it('should return false for non-existent position', () => {
      // Act
      const result = deleteNotePosition(testDb.db, 'notes/nonexistent.md')

      // Assert
      expect(result).toBe(false)
    })

    it('should not affect other positions', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/keep.md', '', 0)
      setNotePosition(testDb.db, 'notes/delete.md', '', 1)

      // Act
      deleteNotePosition(testDb.db, 'notes/delete.md')

      // Assert
      expect(getNotePosition(testDb.db, 'notes/keep.md')).toBeDefined()
    })
  })

  // =========================================================================
  // moveNoteToFolder
  // =========================================================================
  describe('moveNoteToFolder', () => {
    it('should move note to new folder with auto-position', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/source/note.md', 'source', 0)
      setNotePosition(testDb.db, 'notes/target/existing.md', 'target', 0)

      // Act
      moveNoteToFolder(testDb.db, 'notes/source/note.md', 'target')

      // Assert
      const result = getNotePosition(testDb.db, 'notes/source/note.md')
      expect(result?.folderPath).toBe('target')
      expect(result?.position).toBe(1)
    })

    it('should move note to new folder with explicit position', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/source/note.md', 'source', 5)

      // Act
      moveNoteToFolder(testDb.db, 'notes/source/note.md', 'target', 10)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/source/note.md')
      expect(result?.folderPath).toBe('target')
      expect(result?.position).toBe(10)
    })

    it('should handle move to root folder', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/folder/note.md', 'folder', 0)

      // Act
      moveNoteToFolder(testDb.db, 'notes/folder/note.md', '')

      // Assert
      const result = getNotePosition(testDb.db, 'notes/folder/note.md')
      expect(result?.folderPath).toBe('')
    })

    it('should create position for note without existing position', () => {
      // Act
      moveNoteToFolder(testDb.db, 'notes/new-note.md', 'target', 0)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/new-note.md')
      expect(result).toBeDefined()
      expect(result?.folderPath).toBe('target')
    })
  })

  // =========================================================================
  // insertNoteAtPosition
  // =========================================================================
  describe('insertNoteAtPosition', () => {
    it('should shift existing notes to make room', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note-0.md', '', 0)
      setNotePosition(testDb.db, 'notes/note-1.md', '', 1)
      setNotePosition(testDb.db, 'notes/note-2.md', '', 2)

      insertNoteAtPosition(testDb.db, 'notes/new-note.md', '', 1)

      // Assert
      const notes = getNotesInFolder(testDb.db, '')
      expect(notes).toHaveLength(4)
      expect(notes[0].path).toBe('notes/note-0.md')
      expect(notes[0].position).toBe(0)
      expect(notes[1].path).toBe('notes/new-note.md')
      expect(notes[1].position).toBe(1)
      expect(notes[2].path).toBe('notes/note-1.md')
      expect(notes[2].position).toBe(2)
      expect(notes[3].path).toBe('notes/note-2.md')
      expect(notes[3].position).toBe(3)
    })

    it('should insert note at specified position', () => {
      // Act
      insertNoteAtPosition(testDb.db, 'notes/new.md', 'folder', 5)

      // Assert
      const result = getNotePosition(testDb.db, 'notes/new.md')
      expect(result?.position).toBe(5)
    })

    it('should not shift notes before insertion point', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note-0.md', '', 0)
      setNotePosition(testDb.db, 'notes/note-1.md', '', 1)
      setNotePosition(testDb.db, 'notes/note-5.md', '', 5)

      insertNoteAtPosition(testDb.db, 'notes/new.md', '', 3)

      expect(getNotePosition(testDb.db, 'notes/note-0.md')?.position).toBe(0)
      expect(getNotePosition(testDb.db, 'notes/note-1.md')?.position).toBe(1)
      expect(getNotePosition(testDb.db, 'notes/new.md')?.position).toBe(3)
      expect(getNotePosition(testDb.db, 'notes/note-5.md')?.position).toBe(6)
    })

    it('should handle inserting at position 0', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note-0.md', '', 0)
      setNotePosition(testDb.db, 'notes/note-1.md', '', 1)

      // Act
      insertNoteAtPosition(testDb.db, 'notes/first.md', '', 0)

      // Assert
      const notes = getNotesInFolder(testDb.db, '')
      expect(notes[0].path).toBe('notes/first.md')
      expect(notes[0].position).toBe(0)
      expect(notes[1].path).toBe('notes/note-0.md')
      expect(notes[1].position).toBe(1)
    })

    it('should handle reinserting same note at different position', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/note-0.md', '', 0)
      setNotePosition(testDb.db, 'notes/note-1.md', '', 1)
      setNotePosition(testDb.db, 'notes/note-2.md', '', 2)

      insertNoteAtPosition(testDb.db, 'notes/note-0.md', '', 2)

      const result = getNotePosition(testDb.db, 'notes/note-0.md')
      expect(result?.position).toBe(2)
    })
  })

  // =========================================================================
  // getAllNotePositions
  // =========================================================================
  describe('getAllNotePositions', () => {
    it('should return all position records', () => {
      // Arrange
      setNotePosition(testDb.db, 'notes/root.md', '', 0)
      setNotePosition(testDb.db, 'notes/work/task.md', 'work', 0)
      setNotePosition(testDb.db, 'notes/personal/diary.md', 'personal', 1)

      // Act
      const result = getAllNotePositions(testDb.db)

      // Assert
      expect(result).toHaveLength(3)
      expect(result.map((p) => p.path).sort()).toEqual([
        'notes/personal/diary.md',
        'notes/root.md',
        'notes/work/task.md'
      ])
    })

    it('should return empty array when no positions', () => {
      // Act
      const result = getAllNotePositions(testDb.db)

      // Assert
      expect(result).toEqual([])
    })
  })
  // =========================================================================
  // placeNewItemAtTop — #1646
  // =========================================================================
  describe('placeNewItemAtTop', () => {
    it('puts a new note above every note the user has dragged', () => {
      // #given a folder the user arranged by hand
      reorderNotesInFolder(testDb.db, 'work', ['work/a.md', 'work/b.md', 'work/c.md'])

      // #when a note is created in it
      placeNewItemAtTop(testDb.db, 'work/Untitled.md', 'work')

      // #then it leads the folder instead of sorting below all three as a
      // row-less MAX_SAFE_INTEGER item would
      expect(getNotesInFolder(testDb.db, 'work').map((n) => n.path)).toEqual([
        'work/Untitled.md',
        'work/a.md',
        'work/b.md',
        'work/c.md'
      ])
    })

    it('writes nothing in a folder nobody has ordered', () => {
      // #given a folder still running on the tree's implicit order
      // #when a note is created in it
      placeNewItemAtTop(testDb.db, 'work/Untitled.md', 'work')

      // #then no row is written: a row would freeze newest-first ordering for
      // good, and the new note already leads that order
      expect(getAllNotePositions(testDb.db)).toEqual([])
    })

    it('clears the row a deleted item left at the same path', () => {
      // #given a stale row under a path nothing holds any more, in a folder
      // with no other manual order
      setNotePosition(testDb.db, 'work/Untitled.md', 'work', 7)

      // #when a new note takes that path
      placeNewItemAtTop(testDb.db, 'work/Untitled.md', 'work')

      // #then it does not inherit the stranger's slot
      expect(getNotePosition(testDb.db, 'work/Untitled.md')).toBeUndefined()
    })

    it('stacks repeated creations newest-first', () => {
      reorderNotesInFolder(testDb.db, 'work', ['work/a.md'])

      placeNewItemAtTop(testDb.db, 'work/first.md', 'work')
      placeNewItemAtTop(testDb.db, 'work/second.md', 'work')

      expect(getNotesInFolder(testDb.db, 'work').map((n) => n.path)).toEqual([
        'work/second.md',
        'work/first.md',
        'work/a.md'
      ])
    })

    it('reads only the target folder', () => {
      reorderNotesInFolder(testDb.db, 'other', ['other/a.md', 'other/b.md'])

      placeNewItemAtTop(testDb.db, 'work/Untitled.md', 'work')

      expect(getNotePosition(testDb.db, 'work/Untitled.md')).toBeUndefined()
    })

    it('orders new items at the vault root', () => {
      reorderNotesInFolder(testDb.db, '', ['a.md', 'b.md'])

      placeNewItemAtTop(testDb.db, 'Untitled.md', '')

      expect(getNotesInFolder(testDb.db, '')[0].path).toBe('Untitled.md')
    })
  })

  // =========================================================================
  // carryPositionToPath — #1646
  // =========================================================================
  describe('carryPositionToPath', () => {
    it('keeps the slot when a note is renamed', () => {
      // #given a new note sitting at the top of a hand-ordered folder
      reorderNotesInFolder(testDb.db, 'work', ['work/a.md', 'work/b.md'])
      placeNewItemAtTop(testDb.db, 'work/Untitled.md', 'work')

      // #when the rename input that opened with it is committed
      carryPositionToPath(testDb.db, 'work/Untitled.md', 'work/Q3 plan.md')

      // #then the row moves with it and the list does not resort
      expect(getNotesInFolder(testDb.db, 'work').map((n) => n.path)).toEqual([
        'work/Q3 plan.md',
        'work/a.md',
        'work/b.md'
      ])
      expect(getNotePosition(testDb.db, 'work/Untitled.md')).toBeUndefined()
    })

    it('does not invent a position for a note that never had one', () => {
      carryPositionToPath(testDb.db, 'work/a.md', 'work/b.md')

      expect(getAllNotePositions(testDb.db)).toEqual([])
    })

    it('is a no-op when the path does not change', () => {
      setNotePosition(testDb.db, 'work/a.md', 'work', 3)

      carryPositionToPath(testDb.db, 'work/a.md', 'work/a.md')

      expect(getNotePosition(testDb.db, 'work/a.md')?.position).toBe(3)
    })
  })

  // =========================================================================
  // carryFolderPositions — #1646
  // =========================================================================
  describe('carryFolderPositions', () => {
    it('carries the folder and everything under it', () => {
      // #given an ordered folder holding an ordered note and subfolder
      setNotePosition(testDb.db, 'Work', '', 0)
      setNotePosition(testDb.db, 'Work/a.md', 'Work', 0)
      setNotePosition(testDb.db, 'Work/Sub', 'Work', 1)
      setNotePosition(testDb.db, 'Work/Sub/deep.md', 'Work/Sub', 0)

      // #when the folder is renamed
      carryFolderPositions(testDb.db, 'Work', 'Projects')

      // #then every row follows, path and parent alike
      expect(getNotePosition(testDb.db, 'Projects')).toMatchObject({ folderPath: '', position: 0 })
      expect(getNotePosition(testDb.db, 'Projects/a.md')).toMatchObject({
        folderPath: 'Projects',
        position: 0
      })
      expect(getNotePosition(testDb.db, 'Projects/Sub/deep.md')).toMatchObject({
        folderPath: 'Projects/Sub',
        position: 0
      })
      expect(getNotePosition(testDb.db, 'Work')).toBeUndefined()
      expect(getNotePosition(testDb.db, 'Work/a.md')).toBeUndefined()
    })

    it('re-derives the parent when the folder moves to another parent', () => {
      setNotePosition(testDb.db, 'Work', '', 2)

      carryFolderPositions(testDb.db, 'Work', 'Archive/Work')

      expect(getNotePosition(testDb.db, 'Archive/Work')).toMatchObject({
        folderPath: 'Archive',
        position: 2
      })
    })

    it('leaves a sibling whose name starts with the same letters alone', () => {
      // #given `Workspace` next to `Work` — a plain prefix test would sweep it
      setNotePosition(testDb.db, 'Workspace/a.md', 'Workspace', 0)
      setNotePosition(testDb.db, 'Work/a.md', 'Work', 0)

      carryFolderPositions(testDb.db, 'Work', 'Projects')

      expect(getNotePosition(testDb.db, 'Workspace/a.md')).toMatchObject({
        folderPath: 'Workspace'
      })
    })

    it('does nothing for a folder with no ordered contents', () => {
      carryFolderPositions(testDb.db, 'Work', 'Projects')

      expect(getAllNotePositions(testDb.db)).toEqual([])
    })
  })

  // =========================================================================
  // dropFolderPositions — #1646
  // =========================================================================
  describe('dropFolderPositions', () => {
    it('drops the folder row and everything beneath it', () => {
      setNotePosition(testDb.db, 'Work', '', 0)
      setNotePosition(testDb.db, 'Work/a.md', 'Work', 0)
      setNotePosition(testDb.db, 'Work/Sub/deep.md', 'Work/Sub', 0)
      setNotePosition(testDb.db, 'Other/a.md', 'Other', 0)

      dropFolderPositions(testDb.db, 'Work')

      expect(getAllNotePositions(testDb.db).map((r) => r.path)).toEqual(['Other/a.md'])
    })

    it('leaves a sibling whose name starts with the same letters alone', () => {
      setNotePosition(testDb.db, 'Workspace/a.md', 'Workspace', 0)

      dropFolderPositions(testDb.db, 'Work')

      expect(getNotePosition(testDb.db, 'Workspace/a.md')).toBeDefined()
    })
  })
})
