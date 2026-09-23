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
  collectFolderSubtreeIds,
  hideVaultFiles,
  isVaultFile,
  setFoldersExpanded,
  getFileIcon,
  getFileExtensionLabel,
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
  it('extracts the vault-relative folder', () => {
    expect(extractFolderFromPath('Projects/hello.md')).toBe('Projects')
  })

  it('returns empty for a note in the vault root', () => {
    expect(extractFolderFromPath('hello.md')).toBe('')
  })

  it('handles nested folders', () => {
    expect(extractFolderFromPath('a/b/c/file.md')).toBe('a/b/c')
  })

  it('treats a folder named like the notes root as an ordinary folder (#1204)', () => {
    // `defaultNoteFolder` is where new notes go, not a tree root. Stripping a
    // leading "notes" used to fabricate folder nodes the folder APIs could not
    // resolve, which is what made the folder view come up empty.
    expect(extractFolderFromPath('notes/Projects/hello.md')).toBe('notes/Projects')
    expect(extractFolderFromPath('notes/hello.md')).toBe('notes')
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

describe('collectFolderSubtreeIds', () => {
  const deepTree = (): TreeStructure => ({
    folders: [
      {
        name: 'P1',
        path: 'P1',
        notes: [],
        children: [
          {
            name: 'Personal',
            path: 'P1/Personal',
            notes: [],
            children: [
              { name: 'Identity', path: 'P1/Personal/Identity', notes: [], children: [] },
              { name: 'Health', path: 'P1/Personal/Health', notes: [], children: [] }
            ]
          },
          { name: 'Work', path: 'P1/Work', notes: [], children: [] }
        ]
      },
      // Shares a name prefix with P1 but is not below it.
      { name: 'P10', path: 'P10', notes: [], children: [] }
    ],
    rootNotes: []
  })

  it('returns the folder itself first, then every folder below it', () => {
    expect(collectFolderSubtreeIds(deepTree(), 'P1')).toEqual([
      'folder-P1',
      'folder-P1/Personal',
      'folder-P1/Personal/Identity',
      'folder-P1/Personal/Health',
      'folder-P1/Work'
    ])
  })

  it('stays inside a nested folder and leaves siblings and look-alikes out', () => {
    expect(collectFolderSubtreeIds(deepTree(), 'P1/Personal')).toEqual([
      'folder-P1/Personal',
      'folder-P1/Personal/Identity',
      'folder-P1/Personal/Health'
    ])
    expect(collectFolderSubtreeIds(deepTree(), 'P10')).toEqual(['folder-P10'])
  })

  it('returns just the folder for a leaf, and nothing for an unknown path', () => {
    expect(collectFolderSubtreeIds(deepTree(), 'P1/Work')).toEqual(['folder-P1/Work'])
    expect(collectFolderSubtreeIds(deepTree(), 'Nope')).toEqual([])
    expect(collectFolderSubtreeIds(deepTree(), 'P1/Nope')).toEqual([])
  })
})

describe('setFoldersExpanded', () => {
  it('opens and closes only the listed ids', () => {
    const start = new Set(['folder-Other', 'folder-A'])

    expect([...setFoldersExpanded(start, ['folder-A', 'folder-A/B'], true)].sort()).toEqual([
      'folder-A',
      'folder-A/B',
      'folder-Other'
    ])
    expect([...setFoldersExpanded(start, ['folder-A', 'folder-A/B'], false)]).toEqual([
      'folder-Other'
    ])
  })

  it('hands back the same set when nothing changes', () => {
    const start = new Set(['folder-A'])
    expect(setFoldersExpanded(start, ['folder-A'], true)).toBe(start)
    expect(setFoldersExpanded(start, ['folder-B'], false)).toBe(start)
  })
})

// ============================================================================
// buildTreeFromNotes
// ============================================================================

describe('buildTreeFromNotes notesFirst', () => {
  it('records the flag on the tree and leaves each group in sort order', () => {
    const notes = [
      createNote({ id: 'b', path: 'b.md', title: 'b' }),
      createNote({ id: 'a', path: 'a.md', title: 'a' })
    ]
    const folders = [
      { path: 'Z', icon: null },
      { path: 'Y', icon: null }
    ]

    const off = buildTreeFromNotes(notes, folders, {}, 'name-asc')
    const on = buildTreeFromNotes(notes, folders, {}, 'name-asc', true)

    expect(off.notesFirst).toBe(false)
    expect(on.notesFirst).toBe(true)
    expect(on.rootNotes.map((n) => n.id)).toEqual(off.rootNotes.map((n) => n.id))
    expect(on.folders.map((f) => f.path)).toEqual(['Y', 'Z'])
  })
})

describe('hideVaultFiles', () => {
  const md = createNote({ id: 'md', path: 'Docs/readme.md', fileType: 'markdown' })
  const legacy = createNote({ id: 'legacy', path: 'Docs/old.md' })
  const pdf = createNote({ id: 'pdf', path: 'Docs/paper.pdf', fileType: 'pdf' })
  const png = createNote({ id: 'png', path: 'shot.png', fileType: 'image' })
  const mp3 = createNote({ id: 'mp3', path: 'Media/Audio/song.mp3', fileType: 'audio' })

  it('tells files from notes, treating a missing fileType as a note', () => {
    expect([md, legacy, pdf, png, mp3].map(isVaultFile)).toEqual([false, false, true, true, true])
  })

  it('drops files at every level and keeps every folder, even one only holding files', () => {
    const full = buildTreeFromNotes([md, legacy, pdf, png, mp3], [], {}, 'name-asc', true)
    const visible = hideVaultFiles(full)

    expect(visible.rootNotes).toEqual([])
    expect(visible.folders.map((f) => f.path)).toEqual(['Docs', 'Media'])
    expect(visible.folders[0].notes.map((n) => n.id).sort()).toEqual(['legacy', 'md'])
    expect(visible.folders[1].children.map((f) => f.path)).toEqual(['Media/Audio'])
    expect(visible.folders[1].children[0].notes).toEqual([])
    expect(visible.notesFirst).toBe(true)
  })

  it('leaves the tree it was given untouched', () => {
    const full = buildTreeFromNotes([md, pdf, png], [], {})
    hideVaultFiles(full)

    expect(full.rootNotes.map((n) => n.id)).toEqual(['png'])
    expect(full.folders[0].notes.map((n) => n.id).sort()).toEqual(['md', 'pdf'])
  })
})

describe('buildTreeFromNotes', () => {
  it('places notes in correct folders', () => {
    const notes = [
      createNote({ id: 'a', path: 'hello.md', modified: baseDate }),
      createNote({ id: 'b', path: 'Projects/alpha.md', modified: baseDate })
    ]
    const folders = [{ path: 'Projects', icon: null }]

    const tree = buildTreeFromNotes(notes, folders, {})
    expect(tree.rootNotes).toHaveLength(1)
    expect(tree.rootNotes[0].id).toBe('a')
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].notes).toHaveLength(1)
    expect(tree.folders[0].notes[0].id).toBe('b')
  })

  it('keeps a folder named like the notes root browsable (#1204)', () => {
    // A vault with `defaultNoteFolder = 'notes'` must show `notes/` as a real
    // folder. Stripping it produced a node whose path the folder APIs could not
    // resolve, so the folder view opened empty and folderExists said "not
    // found". Every folder node here carries a path the vault can resolve.
    const notes = [
      createNote({ id: 'a', path: 'notes/hello.md', modified: baseDate }),
      createNote({ id: 'b', path: 'travel/kyoto.md', modified: baseDate })
    ]
    const folders = [
      { path: 'notes', icon: null },
      { path: 'travel', icon: null }
    ]

    const tree = buildTreeFromNotes(notes, folders, {})
    expect(tree.rootNotes).toHaveLength(0)
    expect(tree.folders.map((f) => f.path)).toEqual(['notes', 'travel'])
    expect(tree.folders[0].notes.map((n) => n.id)).toEqual(['a'])
    expect(tree.folders[1].notes.map((n) => n.id)).toEqual(['b'])
  })

  it('sorts by position then by modified date', () => {
    const earlier = new Date(2025, 0, 1)
    const later = new Date(2026, 0, 1)
    const notes = [
      createNote({ id: 'a', path: 'a.md', modified: earlier }),
      createNote({ id: 'b', path: 'b.md', modified: later }),
      createNote({ id: 'c', path: 'c.md', modified: earlier })
    ]
    const positions = { 'c.md': 0, 'a.md': 1 }

    const tree = buildTreeFromNotes(notes, [], positions)
    expect(tree.rootNotes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
  })

  it('creates intermediate folders for nested paths', () => {
    const notes = [createNote({ id: 'a', path: 'a/b/c/file.md', modified: baseDate })]
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

// ============================================================================
// getFileExtensionLabel
// ============================================================================

describe('getFileExtensionLabel', () => {
  it('returns null for markdown notes', () => {
    expect(getFileExtensionLabel(createNote({ path: 'notes/note.md' }))).toBeNull()
  })

  it('returns uppercase extension for non-markdown files', () => {
    expect(
      getFileExtensionLabel(
        createNote({ path: 'notes/song.mp3', fileType: 'audio' as NoteListItem['fileType'] })
      )
    ).toBe('MP3')
    expect(
      getFileExtensionLabel(
        createNote({ path: 'notes/doc.pdf', fileType: 'pdf' as NoteListItem['fileType'] })
      )
    ).toBe('PDF')
  })

  it('returns null when fileType is missing', () => {
    expect(getFileExtensionLabel(createNote({ path: 'notes/mystery.xyz' }))).toBeNull()
  })
})
