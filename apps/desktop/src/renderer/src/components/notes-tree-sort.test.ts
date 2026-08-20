import { describe, it, expect } from 'vitest'
import { buildTreeFromNotes } from './notes-tree-utils'
import { SIDEBAR_SORT_DEFAULTS } from '@memry/contracts/sidebar-sort'
import { compareFolders, compareNotes } from './notes-tree-sort'
import type { NoteListItem } from '@memry/contracts/notes-api'

function note(path: string, created: string, modified: string): NoteListItem {
  return {
    id: path,
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    created: new Date(created),
    modified: new Date(modified),
    tags: [],
    wordCount: null
  }
}

// Titles, creation order and modification order are all deliberately different
// so a comparator that reads the wrong field cannot pass by coincidence.
const NOTES = [
  note('Beta.md', '2026-01-03', '2026-02-01'),
  note('alpha.md', '2026-01-01', '2026-02-03'),
  note('Gamma.md', '2026-01-02', '2026-02-02')
]

const FOLDERS = [{ path: 'Zeta' }, { path: 'apple' }, { path: 'Mango' }]

const titles = (items: { title: string }[]): string[] => items.map((i) => i.title)
const names = (items: { name: string }[]): string[] => items.map((i) => i.name)

describe('sidebar sort modes', () => {
  it('sorts notes by title, case-insensitively, in both directions', () => {
    expect([...NOTES].sort(compareNotes('name-asc', {})).map((n) => n.title)).toEqual([
      'alpha',
      'Beta',
      'Gamma'
    ])
    expect([...NOTES].sort(compareNotes('name-desc', {})).map((n) => n.title)).toEqual([
      'Gamma',
      'Beta',
      'alpha'
    ])
  })

  it('sorts notes by modified and created independently', () => {
    expect([...NOTES].sort(compareNotes('modified-desc', {})).map((n) => n.title)).toEqual([
      'alpha',
      'Gamma',
      'Beta'
    ])
    expect([...NOTES].sort(compareNotes('created-desc', {})).map((n) => n.title)).toEqual([
      'Beta',
      'Gamma',
      'alpha'
    ])
    expect([...NOTES].sort(compareNotes('created-asc', {})).map((n) => n.title)).toEqual([
      'alpha',
      'Gamma',
      'Beta'
    ])
  })

  it('falls back to newest-first for notes with no stored position in manual mode', () => {
    expect([...NOTES].sort(compareNotes('manual', {})).map((n) => n.title)).toEqual([
      'alpha',
      'Gamma',
      'Beta'
    ])
  })

  it('honours stored positions in manual mode', () => {
    const positions = { 'Beta.md': 0, 'Gamma.md': 1, 'alpha.md': 2 }
    expect([...NOTES].sort(compareNotes('manual', positions)).map((n) => n.title)).toEqual([
      'Beta',
      'Gamma',
      'alpha'
    ])
  })

  // Folders carry no timestamp anywhere in the tree payload, so a time mode
  // must leave them A→Z rather than inventing an order — and must not flip them
  // to Z→A just because the mode itself is descending.
  it('keeps folders A→Z under every time mode, in both directions', () => {
    const folders = [
      { name: 'Zeta', path: 'Zeta' },
      { name: 'apple', path: 'apple' }
    ]
    for (const mode of ['modified-desc', 'modified-asc', 'created-desc', 'created-asc'] as const) {
      expect(names([...folders].sort(compareFolders(mode, {})))).toEqual(['apple', 'Zeta'])
    }
  })

  // The pre-sort-mode comparator was a bare `localeCompare`. Base sensitivity
  // would tie these two and leave their order to sort stability instead.
  it('keeps the legacy case tiebreak between otherwise-equal folder names', () => {
    const folders = [
      { name: 'alpha', path: 'alpha' },
      { name: 'Alpha', path: 'Alpha' }
    ]
    const sorted = names([...folders].sort(compareFolders('name-asc', {})))
    expect(sorted).toEqual(['alpha', 'Alpha'].sort((a, b) => a.localeCompare(b)))
    expect(sorted[0]).not.toBe(sorted[1])
  })

  it('flips folders only for the name modes', () => {
    const folders = [
      { name: 'Zeta', path: 'Zeta' },
      { name: 'apple', path: 'apple' }
    ]
    expect(names([...folders].sort(compareFolders('name-desc', {})))).toEqual(['Zeta', 'apple'])
  })
})

describe('buildTreeFromNotes backward compatibility', () => {
  // The whole upgrade story rests on this: the mode every existing install
  // lands on must reproduce, byte for byte, the order the tree already had —
  // folders A→Z, notes newest-first. If this fails, shipping sort modes
  // silently reshuffles every user's sidebar.
  it('reproduces the pre-sort-mode order under the collections default', () => {
    const legacy = buildTreeFromNotes(NOTES, FOLDERS, {})
    const withDefault = buildTreeFromNotes(NOTES, FOLDERS, {}, SIDEBAR_SORT_DEFAULTS.collections)

    expect(names(withDefault.folders)).toEqual(names(legacy.folders))
    expect(titles(withDefault.rootNotes)).toEqual(titles(legacy.rootNotes))
    expect(names(legacy.folders)).toEqual(['apple', 'Mango', 'Zeta'])
    expect(titles(legacy.rootNotes)).toEqual(['alpha', 'Gamma', 'Beta'])
  })

  // The case that separates the candidate defaults, and the one an empty
  // fixture cannot see: on a vault somebody has already dragged into order,
  // a time-based default would throw that order away. Only a position-first
  // default preserves it.
  it('keeps a vault that has already been hand-ordered', () => {
    const positions = { 'Beta.md': 0, 'Gamma.md': 1, 'alpha.md': 2, Zeta: 0, apple: 1, Mango: 2 }

    const legacy = buildTreeFromNotes(NOTES, FOLDERS, positions)
    expect(titles(legacy.rootNotes)).toEqual(['Beta', 'Gamma', 'alpha'])
    expect(names(legacy.folders)).toEqual(['Zeta', 'apple', 'Mango'])

    const withDefault = buildTreeFromNotes(
      NOTES,
      FOLDERS,
      positions,
      SIDEBAR_SORT_DEFAULTS.collections
    )
    expect(titles(withDefault.rootNotes)).toEqual(titles(legacy.rootNotes))
    expect(names(withDefault.folders)).toEqual(names(legacy.folders))

    // Proof the assertion above has teeth: a time mode really does discard it.
    const timeMode = buildTreeFromNotes(NOTES, FOLDERS, positions, 'modified-desc')
    expect(titles(timeMode.rootNotes)).not.toEqual(titles(legacy.rootNotes))
  })

  it('reorders the tree when a different mode is passed', () => {
    const byName = buildTreeFromNotes(NOTES, FOLDERS, {}, 'name-desc')
    expect(names(byName.folders)).toEqual(['Zeta', 'Mango', 'apple'])
    expect(titles(byName.rootNotes)).toEqual(['Gamma', 'Beta', 'alpha'])
  })
})

describe('new items in a hand-ordered vault (#1646)', () => {
  const HAND_ORDERED = { 'Beta.md': 0, 'Gamma.md': 1, 'alpha.md': 2, Zeta: 0, apple: 1, Mango: 2 }

  // The half of the bug that lives in the renderer: a missing row reads as
  // MAX_SAFE_INTEGER, so anything without one sorts under everything the user
  // ever dragged. Main answers it by writing a row at creation — this test is
  // the tripwire for the day someone removes that write.
  it('sorts an item with no stored position under every positioned sibling', () => {
    const fresh = note('Untitled.md', '2026-03-01', '2026-03-01')
    const tree = buildTreeFromNotes(
      [...NOTES, fresh],
      [...FOLDERS, { path: 'Untitled Folder' }],
      HAND_ORDERED
    )

    expect(titles(tree.rootNotes).at(-1)).toBe('Untitled')
    expect(names(tree.folders).at(-1)).toBe('Untitled Folder')
  })

  // What main now writes: `min - 1`, which is negative as soon as a hand-ordered
  // folder starts at 0. Nothing in the tree may clamp that to zero.
  it('leads the list once main gives the new item the slot above the top one', () => {
    const fresh = note('Untitled.md', '2026-03-01', '2026-03-01')
    const positions = { ...HAND_ORDERED, 'Untitled.md': -1, 'Untitled Folder': -1 }
    const tree = buildTreeFromNotes(
      [...NOTES, fresh],
      [...FOLDERS, { path: 'Untitled Folder' }],
      positions
    )

    expect(titles(tree.rootNotes)).toEqual(['Untitled', 'Beta', 'Gamma', 'alpha'])
    expect(names(tree.folders)).toEqual(['Untitled Folder', 'Zeta', 'apple', 'Mango'])
  })

  // The rename that opens with every new note renames the row's key too, which
  // is why main carries the position across the path change. Same slot, new
  // path: the row must still be the one the tree reads.
  it('holds the slot when the new note is renamed', () => {
    const renamed = note('Q3 plan.md', '2026-03-01', '2026-03-01')
    const positions = { ...HAND_ORDERED, 'Q3 plan.md': -1 }
    const tree = buildTreeFromNotes([...NOTES, renamed], FOLDERS, positions)

    expect(titles(tree.rootNotes)).toEqual(['Q3 plan', 'Beta', 'Gamma', 'alpha'])
  })
})
