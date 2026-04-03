import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { NoteListItem } from '@/hooks/use-notes-query'
import {
  getDisplayName,
  extractFolderFromPath,
  getParentFolder,
  isDescendantOrSelf,
  getNotesInFolder,
  getFoldersInParent,
  buildTreeFromNotes,
  collectAllFolderIds,
  getFileIcon,
  type FolderNode,
  type TreeStructure
} from './notes-tree-utils'

const baseDate = new Date(2026, 0, 1)

const createNote = (overrides: Partial<NoteListItem> = {}): NoteListItem => ({
  id: 'note-1',
  path: 'notes/note-1.md',
  title: 'Sample Note',
  created: baseDate,
  modified: baseDate,
  tags: [],
  wordCount: 0,
  emoji: null,
  ...overrides
})

const makeTree = (): TreeStructure => {
  const note1 = createNote({ id: 'n1', path: 'notes/hello.md' })
  const note2 = createNote({ id: 'n2', path: 'notes/world.md' })
  const childNote = createNote({ id: 'n3', path: 'notes/docs/readme.md' })
  const deepNote = createNote({ id: 'n4', path: 'notes/docs/api/spec.md' })

  const apiFolder: FolderNode = {
    name: 'api',
    path: 'docs/api',
    children: [],
    notes: [deepNote]
  }

  const docsFolder: FolderNode = {
    name: 'docs',
    path: 'docs',
    children: [apiFolder],
    notes: [childNote]
  }

  return {
    folders: [docsFolder],
    rootNotes: [note1, note2]
  }
}

// ============================================================================
// getDisplayName
// ============================================================================

describe('getDisplayName', () => {
  it('strips folder path and extension', () => {
    expect(getDisplayName('notes/Projects/Alpha.md')).toBe('Alpha')
  })

  it('handles file without extension', () => {
    expect(getDisplayName('notes/README')).toBe('README')
  })

  it('handles dotfiles', () => {
    expect(getDisplayName('.gitignore')).toBe('.gitignore')
  })

  it('handles multiple dots', () => {
    expect(getDisplayName('notes/my.file.name.md')).toBe('my.file.name')
  })
})

// ============================================================================
// extractFolderFromPath
// ============================================================================

describe('extractFolderFromPath', () => {
  it('extracts folder from notes-prefixed path', () => {
    expect(extractFolderFromPath('notes/Projects/hello.md')).toBe('Projects')
  })

  it('returns empty for root note', () => {
    expect(extractFolderFromPath('notes/hello.md')).toBe('')
  })

  it('handles nested folders', () => {
    expect(extractFolderFromPath('notes/a/b/c/file.md')).toBe('a/b/c')
  })

  it('handles non-notes-prefixed path', () => {
    expect(extractFolderFromPath('Projects/hello.md')).toBe('Projects')
  })
})

// ============================================================================
// getParentFolder
// ============================================================================

describe('getParentFolder', () => {
  it('returns parent of nested folder', () => {
    expect(getParentFolder('a/b/c')).toBe('a/b')
  })

  it('returns empty for root folder', () => {
    expect(getParentFolder('root')).toBe('')
  })
})

// ============================================================================
// isDescendantOrSelf
// ============================================================================

describe('isDescendantOrSelf', () => {
  it('returns true for self', () => {
    expect(isDescendantOrSelf('docs', 'docs')).toBe(true)
  })

  it('returns true for descendant', () => {
    expect(isDescendantOrSelf('docs', 'docs/api')).toBe(true)
  })

  it('returns false for unrelated', () => {
    expect(isDescendantOrSelf('docs', 'projects')).toBe(false)
  })

  it('returns false for partial prefix match', () => {
    expect(isDescendantOrSelf('doc', 'docs')).toBe(false)
  })
})

// ============================================================================
// getNotesInFolder
// ============================================================================

describe('getNotesInFolder', () => {
  it('returns root notes for empty path', () => {
    const tree = makeTree()
    expect(getNotesInFolder(tree, '')).toHaveLength(2)
  })

  it('returns notes in specific folder', () => {
    const tree = makeTree()
    const notes = getNotesInFolder(tree, 'docs')
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe('n3')
  })

  it('returns notes in nested folder', () => {
    const tree = makeTree()
    const notes = getNotesInFolder(tree, 'docs/api')
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe('n4')
  })

  it('returns empty array for non-existent folder', () => {
    const tree = makeTree()
    expect(getNotesInFolder(tree, 'nonexistent')).toHaveLength(0)
  })
})

// ============================================================================
// getFoldersInParent
// ============================================================================

describe('getFoldersInParent', () => {
  it('returns root folders for empty path', () => {
    const tree = makeTree()
    expect(getFoldersInParent(tree, '')).toEqual(['docs'])
  })

  it('returns child folders', () => {
    const tree = makeTree()
    expect(getFoldersInParent(tree, 'docs')).toEqual(['docs/api'])
  })

  it('returns empty for leaf folder', () => {
    const tree = makeTree()
    expect(getFoldersInParent(tree, 'docs/api')).toEqual([])
  })
})

// ============================================================================
// collectAllFolderIds
// ============================================================================

describe('collectAllFolderIds', () => {
  it('returns prefixed IDs for all folders', () => {
    const tree = makeTree()
    const ids = collectAllFolderIds(tree)
    expect(ids).toContain('folder-docs')
    expect(ids).toContain('folder-docs/api')
    expect(ids).toHaveLength(2)
  })

  it('returns empty for tree with no folders', () => {
    const tree: TreeStructure = { folders: [], rootNotes: [] }
    expect(collectAllFolderIds(tree)).toEqual([])
  })
})

// ============================================================================
// buildTreeFromNotes
// ============================================================================

describe('buildTreeFromNotes', () => {
  it('places notes in correct folders', () => {
    const notes = [
      createNote({ id: 'a', path: 'notes/hello.md', modified: baseDate }),
      createNote({ id: 'b', path: 'notes/Projects/alpha.md', modified: baseDate })
    ]
    const folders = [{ path: 'Projects', icon: null }]

    const tree = buildTreeFromNotes(notes, folders, {})
    expect(tree.rootNotes).toHaveLength(1)
    expect(tree.rootNotes[0].id).toBe('a')
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].notes).toHaveLength(1)
    expect(tree.folders[0].notes[0].id).toBe('b')
  })

  it('sorts by position then by modified date', () => {
    const earlier = new Date(2025, 0, 1)
    const later = new Date(2026, 0, 1)
    const notes = [
      createNote({ id: 'a', path: 'notes/a.md', modified: earlier }),
      createNote({ id: 'b', path: 'notes/b.md', modified: later }),
      createNote({ id: 'c', path: 'notes/c.md', modified: earlier })
    ]
    const positions = { 'notes/c.md': 0, 'notes/a.md': 1 }

    const tree = buildTreeFromNotes(notes, [], positions)
    expect(tree.rootNotes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
  })

  it('creates intermediate folders for nested paths', () => {
    const notes = [createNote({ id: 'a', path: 'notes/a/b/c/file.md', modified: baseDate })]
    const tree = buildTreeFromNotes(notes, [], {})
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].name).toBe('a')
    expect(tree.folders[0].children[0].name).toBe('b')
    expect(tree.folders[0].children[0].children[0].name).toBe('c')
  })

  it('preserves folder icon from FolderInfo', () => {
    const notes: NoteListItem[] = []
    const folders = [{ path: 'Archive', icon: '📦' }]

    const tree = buildTreeFromNotes(notes, folders, {})
    expect(tree.folders[0].icon).toBe('📦')
  })
})

// ============================================================================
// getFileIcon
// ============================================================================

describe('getFileIcon', () => {
  it('renders emoji when note has one', () => {
    const note = createNote({ emoji: '🔥' })
    const { container } = render(getFileIcon(note))
    expect(container.textContent).toContain('🔥')
  })

  it('renders FileText icon for markdown', () => {
    const note = createNote({ fileType: 'markdown' as NoteListItem['fileType'] })
    const { container } = render(getFileIcon(note))
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('renders appropriate icon for pdf', () => {
    const note = createNote({
      emoji: null,
      fileType: 'pdf' as NoteListItem['fileType']
    })
    const { container } = render(getFileIcon(note))
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.classList.toString()).toContain('red')
  })

  it('renders appropriate icon for image', () => {
    const note = createNote({
      emoji: null,
      fileType: 'image' as NoteListItem['fileType']
    })
    const { container } = render(getFileIcon(note))
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.classList.toString()).toContain('blue')
  })

  it('renders appropriate icon for audio', () => {
    const note = createNote({
      emoji: null,
      fileType: 'audio' as NoteListItem['fileType']
    })
    const { container } = render(getFileIcon(note))
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.classList.toString()).toContain('green')
  })

  it('falls back to FileText for unknown type', () => {
    const note = createNote({ emoji: null })
    const { container } = render(getFileIcon(note))
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
