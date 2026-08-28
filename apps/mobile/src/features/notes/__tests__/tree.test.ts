import { describe, expect, it } from 'vitest'
import { SIDEBAR_SORT_MODES } from '@memry/contracts/sidebar-sort'
import {
  buildFolderTree,
  findFolder,
  flattenFolderTree,
  isMobileSortMode,
  MOBILE_SORT_DEFAULT,
  MOBILE_SORT_MODES,
  NOTE_FILE_TYPE_TONE,
  type MobileSortMode,
  type NoteEntry,
  type NoteFileType,
  type NoteTreeRow
} from '../tree'

/**
 * The notes tree, isolated.
 *
 * Every rule about nesting, counting, sorting and filtering lives in this
 * module so the row renderers carry none of it. That only holds if the rules
 * are pinned here rather than re-derived in a screen, so this suite is the
 * contract: what the desktop sidebar guarantees (folders A→Z under every mode)
 * and what the device cannot do (`manual`, which needs a stored position no
 * sync payload carries).
 */

function entry(
  id: string,
  title: string,
  folderPath: string,
  overrides: Partial<Pick<NoteEntry, 'fileType' | 'updatedAt' | 'createdAt' | 'hasBody'>> = {}
): NoteEntry {
  return {
    id,
    title,
    folderPath,
    fileType: overrides.fileType ?? 'markdown',
    updatedAt: overrides.updatedAt ?? 0,
    createdAt: overrides.createdAt ?? 0,
    hasBody: overrides.hasBody ?? true
  }
}

/**
 * `personal` is lower-case on purpose: a byte comparison sorts it after `Work`,
 * a case-insensitive one puts it second. Every folder-order assertion below
 * fails loudly if the comparator regresses to raw `<`.
 */
const ENTRIES: NoteEntry[] = [
  entry('n1', 'Roadmap', 'Work/Product', { updatedAt: 500, createdAt: 100 }),
  entry('n2', 'Specs', 'Work/Product', { fileType: 'pdf', updatedAt: 300, createdAt: 400 }),
  entry('n3', 'Hiring plan', 'Work', { updatedAt: 400, createdAt: 200 }),
  entry('n4', 'Papers', 'Reading', { updatedAt: 200, createdAt: 300 }),
  // Three levels deep, and only the leaf holds a note: `Archive` and
  // `Archive/2024` exist solely because this note's path names them.
  entry('n7', 'Q3 goals', 'Archive/2024/Plans', { updatedAt: 250, createdAt: 250 }),
  entry('n8', 'Journal ideas', 'personal', { updatedAt: 150, createdAt: 150 }),
  entry('n5', 'Quick capture', '', { updatedAt: 600, createdAt: 600 }),
  entry('n6', 'Weeknotes', '', { updatedAt: 100, createdAt: 500 })
]

const ICONS = new Map([
  ['Work', '💼'],
  ['Archive/2024', '📦']
])

const ALL_FOLDERS = new Set([
  'Archive',
  'Archive/2024',
  'Archive/2024/Plans',
  'personal',
  'Reading',
  'Work',
  'Work/Product'
])

const tree = () => buildFolderTree(ENTRIES, ICONS)

/** `key@level` pins order and nesting depth in one readable array. */
function shape(rows: NoteTreeRow[]): string[] {
  return rows.map((row) => `${row.key}@${row.level}`)
}

function flatten(
  opts: { expanded?: Iterable<string>; sort?: MobileSortMode; query?: string } = {}
) {
  return flattenFolderTree(tree(), {
    expanded: new Set(opts.expanded ?? ALL_FOLDERS),
    sort: opts.sort ?? MOBILE_SORT_DEFAULT,
    query: opts.query ?? ''
  })
}

describe('sort modes', () => {
  it('offers exactly what the collections sidebar offers, minus manual', () => {
    // The device has no per-item order to return to: NoteSyncPayloadSchema has
    // no `position` field, so `manual` would be a mode that changes nothing.
    // This also fails if desktop ADDS a collections mode, which is the moment
    // somebody has to decide whether mobile can honour it.
    expect([...MOBILE_SORT_MODES]).toEqual(
      SIDEBAR_SORT_MODES.collections.filter((mode) => mode !== 'manual')
    )
  })

  it('defaults to the order the notes screen already renders', () => {
    // The list is `ORDER BY s.updated_at DESC` today, so this default moves
    // nobody's notes on upgrade.
    expect(MOBILE_SORT_DEFAULT).toBe('modified-desc')
    expect(MOBILE_SORT_MODES).toContain(MOBILE_SORT_DEFAULT)
  })

  it('guards stored values, including the modes mobile does not offer', () => {
    for (const mode of MOBILE_SORT_MODES) expect(isMobileSortMode(mode)).toBe(true)
    for (const rejected of ['manual', 'count-desc', 'count-asc', '', 'name', null, 7, undefined]) {
      expect(isMobileSortMode(rejected)).toBe(false)
    }
  })
})

describe('buildFolderTree', () => {
  it('materializes intermediate folders that hold no notes of their own', () => {
    const root = tree()
    expect(root.path).toBe('')
    expect(root.name).toBe('')
    expect(root.folders.map((folder) => folder.path)).toEqual([
      'Archive',
      'personal',
      'Reading',
      'Work'
    ])

    const archive = root.folders[0]
    expect(archive.notes).toEqual([])
    expect(archive.folders.map((folder) => ({ path: folder.path, name: folder.name }))).toEqual([
      { path: 'Archive/2024', name: '2024' }
    ])
    const year = archive.folders[0]
    expect(year.notes).toEqual([])
    expect(year.folders.map((folder) => folder.name)).toEqual(['Plans'])
    expect(year.folders[0].notes.map((note) => note.id)).toEqual(['n7'])
  })

  it('keeps root-level notes on the synthetic root', () => {
    expect(
      tree()
        .notes.map((note) => note.id)
        .sort()
    ).toEqual(['n5', 'n6'])
  })

  it('counts notes recursively at every level', () => {
    const root = tree()
    const count = (path: string) => findFolder(root, path)?.noteCount
    expect(root.noteCount).toBe(ENTRIES.length)
    expect(count('Work')).toBe(3)
    expect(count('Work/Product')).toBe(2)
    expect(count('Archive')).toBe(1)
    expect(count('Archive/2024')).toBe(1)
    expect(count('Archive/2024/Plans')).toBe(1)
    expect(count('Reading')).toBe(1)
    expect(count('personal')).toBe(1)
  })

  it('attaches icons by path and leaves the rest null', () => {
    const root = tree()
    expect(findFolder(root, 'Work')?.icon).toBe('💼')
    expect(findFolder(root, 'Archive/2024')?.icon).toBe('📦')
    expect(findFolder(root, 'Reading')?.icon).toBeNull()
    expect(findFolder(root, 'Work/Product')?.icon).toBeNull()
    expect(findFolder(root, 'Archive')?.icon).toBeNull()
  })
})

describe('findFolder', () => {
  it('resolves the root, a nested path, and nothing else', () => {
    const root = tree()
    expect(findFolder(root, '')).toBe(root)
    expect(findFolder(root, 'Work/Product')?.name).toBe('Product')
    expect(findFolder(root, 'Archive/2024')?.name).toBe('2024')
    expect(findFolder(root, 'Work/Nope')).toBeNull()
    expect(findFolder(root, 'Nope')).toBeNull()
    expect(findFolder(root, 'Product')).toBeNull()
  })
})

describe('flattenFolderTree', () => {
  it('emits folders depth-first, then the root loose notes last', () => {
    // Board 26's shape: every folder subtree, and only then the notes that
    // live at the vault root.
    expect(shape(flatten())).toEqual([
      'f:Archive@0',
      'f:Archive/2024@1',
      'f:Archive/2024/Plans@2',
      'n:n7@3',
      'f:personal@0',
      'n:n8@1',
      'f:Reading@0',
      'n:n4@1',
      'f:Work@0',
      'f:Work/Product@1',
      'n:n1@2',
      'n:n2@2',
      'n:n3@1',
      'n:n5@0',
      'n:n6@0'
    ])
  })

  it('emits no row for the synthetic root', () => {
    expect(flatten().some((row) => row.kind === 'folder' && row.node.path === '')).toBe(false)
  })

  it('emits nothing below a collapsed folder', () => {
    expect(shape(flatten({ expanded: [] }))).toEqual([
      'f:Archive@0',
      'f:personal@0',
      'f:Reading@0',
      'f:Work@0',
      'n:n5@0',
      'n:n6@0'
    ])
  })

  it('expands one level at a time', () => {
    // `Work/Product` is emitted because `Work` is open, but its own notes stay
    // hidden because it is not.
    expect(shape(flatten({ expanded: ['Work'] }))).toEqual([
      'f:Archive@0',
      'f:personal@0',
      'f:Reading@0',
      'f:Work@0',
      'f:Work/Product@1',
      'n:n3@1',
      'n:n5@0',
      'n:n6@0'
    ])
    const product = flatten({ expanded: ['Work'] }).find((row) => row.key === 'f:Work/Product')
    expect(product?.kind === 'folder' && product.expanded).toBe(false)
  })

  it('keeps folders A→Z under every sort mode', () => {
    // Folders carry no timestamp, so a time mode has nothing to sort them by;
    // desktop keeps them A→Z in that direction regardless of the mode's own.
    const expected = [
      'Archive',
      'Archive/2024',
      'Archive/2024/Plans',
      'personal',
      'Reading',
      'Work',
      'Work/Product'
    ]
    for (const mode of MOBILE_SORT_MODES) {
      const folders = flatten({ sort: mode })
        .filter((row) => row.kind === 'folder')
        .map((row) => (row.kind === 'folder' ? row.node.path : ''))
      expect(folders, mode).toEqual(expected)
    }
  })

  it('reports the unfiltered recursive count on a filtered row', () => {
    // The row carries the tree's own node, so its count is the folder's real
    // size rather than the number of matches under it.
    const work = flatten({ query: 'roadmap' }).find((row) => row.key === 'f:Work')
    expect(work?.kind === 'folder' && work.node.noteCount).toBe(3)
  })

  it('does not reorder the tree it was given', () => {
    const root = tree()
    const before = findFolder(root, 'Work/Product')?.notes.map((note) => note.id)
    flattenFolderTree(root, {
      expanded: ALL_FOLDERS,
      sort: 'name-desc',
      query: ''
    })
    expect(findFolder(root, 'Work/Product')?.notes.map((note) => note.id)).toEqual(before)
  })
})

describe('note ordering', () => {
  // 'alpha' and 'charlie' are lower-case so a byte comparison would put
  // 'Bravo' first; the case-insensitive one must not.
  const SORTABLE: NoteEntry[] = [
    entry('a', 'alpha', '', { updatedAt: 300, createdAt: 100 }),
    entry('b', 'Bravo', '', { updatedAt: 100, createdAt: 300 }),
    entry('c', 'charlie', '', { updatedAt: 200, createdAt: 200 })
  ]

  /** Exhaustive by construction: a seventh mode fails to compile here. */
  const EXPECTED: Record<MobileSortMode, string[]> = {
    'name-asc': ['a', 'b', 'c'],
    'name-desc': ['c', 'b', 'a'],
    'modified-desc': ['a', 'c', 'b'],
    'modified-asc': ['b', 'c', 'a'],
    'created-desc': ['b', 'c', 'a'],
    'created-asc': ['a', 'c', 'b']
  }

  it('orders notes by the mode', () => {
    const root = buildFolderTree(SORTABLE, new Map())
    for (const mode of MOBILE_SORT_MODES) {
      const ids = flattenFolderTree(root, {
        expanded: new Set(),
        sort: mode,
        query: ''
      }).map((row) => (row.kind === 'note' ? row.note.id : ''))
      expect(ids, mode).toEqual(EXPECTED[mode])
    }
  })

  it('breaks every tie by id, in the descending modes too', () => {
    // Identical titles and identical timestamps. Without the id tiebreak these
    // two swap between renders on whatever order the query happened to return.
    const tied = buildFolderTree(
      [
        entry('zzz', 'Same', '', { updatedAt: 100, createdAt: 100 }),
        entry('aaa', 'Same', '', { updatedAt: 100, createdAt: 100 })
      ],
      new Map()
    )
    for (const mode of MOBILE_SORT_MODES) {
      const ids = flattenFolderTree(tied, {
        expanded: new Set(),
        sort: mode,
        query: ''
      }).map((row) => (row.kind === 'note' ? row.note.id : ''))
      expect(ids, mode).toEqual(['aaa', 'zzz'])
    }
  })

  it('sorts each folder independently, not the flattened list', () => {
    const ids = flatten({ sort: 'modified-asc' })
      .filter((row) => row.kind === 'note')
      .map((row) => (row.kind === 'note' ? row.note.id : ''))
    // Work/Product ascending is n2 (300) then n1 (500), and the root's loose
    // notes still come last however old they are.
    expect(ids).toEqual(['n7', 'n8', 'n4', 'n2', 'n1', 'n3', 'n6', 'n5'])
  })
})

describe('query filtering', () => {
  it('keeps every ancestor of a match', () => {
    expect(shape(flatten({ query: 'roadmap' }))).toEqual(['f:Work@0', 'f:Work/Product@1', 'n:n1@2'])
  })

  it('keeps ancestors that hold no notes themselves', () => {
    expect(shape(flatten({ query: 'q3' }))).toEqual([
      'f:Archive@0',
      'f:Archive/2024@1',
      'f:Archive/2024/Plans@2',
      'n:n7@3'
    ])
  })

  it('force-expands survivors even with nothing expanded', () => {
    const rows = flatten({ expanded: [], query: 'roadmap' })
    expect(shape(rows)).toEqual(['f:Work@0', 'f:Work/Product@1', 'n:n1@2'])
    for (const row of rows) {
      if (row.kind === 'folder') expect(row.expanded, row.key).toBe(true)
    }
  })

  it('drops a subtree with no match, folder rows included', () => {
    const rows = flatten({ query: 'roadmap' })
    for (const path of ['Archive', 'Archive/2024', 'personal', 'Reading']) {
      expect(rows.some((row) => row.key === `f:${path}`)).toBe(false)
    }
    expect(flatten({ query: 'nothing matches this' })).toEqual([])
  })

  it('matches case-insensitively on a trimmed substring', () => {
    const expected = ['f:Work@0', 'f:Work/Product@1', 'n:n1@2']
    expect(shape(flatten({ query: 'ROADMAP' }))).toEqual(expected)
    expect(shape(flatten({ query: '  roadmap  ' }))).toEqual(expected)
    expect(shape(flatten({ query: 'oadma' }))).toEqual(expected)
  })

  it('keeps a matching root note with no folder rows around it', () => {
    expect(shape(flatten({ query: 'weeknotes' }))).toEqual(['n:n6@0'])
  })

  it('treats a whitespace-only query as no filter', () => {
    const unfiltered = shape(flatten())
    expect(shape(flatten({ query: '   ' }))).toEqual(unfiltered)
    expect(shape(flatten({ query: '\t\n' }))).toEqual(unfiltered)
  })
})

describe('NOTE_FILE_TYPE_TONE', () => {
  it('tints every file type the notes list can render', () => {
    expect(NOTE_FILE_TYPE_TONE).toEqual({
      markdown: 'tertiary',
      pdf: 'destructive',
      image: 'blue',
      audio: 'green',
      video: 'purple'
    } satisfies Record<NoteFileType, string>)
  })
})
