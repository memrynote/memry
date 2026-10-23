import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isCommandAvailable, resetCommandStoreForTests } from '@/commands/store'
import { runCommand } from '@/commands'
import type { NotesTreeActions } from '@/components/notes-tree'
import { useSidebarTreeCommands } from './use-sidebar-tree-commands'

const mocks = vi.hoisted(() => ({ expandSection: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/components/sidebar-section', () => ({ expandSidebarSection: mocks.expandSection }))

const tree = {
  createNote: vi.fn(),
  createFolder: vi.fn(),
  collapseAll: vi.fn(),
  expandAll: vi.fn()
} satisfies NotesTreeActions
const createCanvas = vi.fn().mockResolvedValue(undefined)
const createProject = vi.fn()
const onFoldersExpandedChange = vi.fn()

const mount = (overrides: { isTreeVisible?: boolean; isCanvasEnabled?: boolean } = {}): void => {
  renderHook(() =>
    useSidebarTreeCommands({
      notesTreeRef: { current: tree },
      isTreeVisible: true,
      isCanvasEnabled: true,
      createCanvas,
      createProject,
      onFoldersExpandedChange,
      ...overrides
    })
  )
}

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
})

describe('sidebar tree commands', () => {
  it('opens the Collections section before asking the tree for a folder name', async () => {
    mount()
    await runCommand('create.folder', 'palette')

    expect(mocks.expandSection).toHaveBeenCalledWith('collections')
    expect(tree.createFolder).toHaveBeenCalledTimes(1)
    expect(mocks.expandSection.mock.invocationCallOrder[0]).toBeLessThan(
      tree.createFolder.mock.invocationCallOrder[0]
    )
  })

  it('expands and collapses every folder, and tells the sidebar button which state it is in', async () => {
    mount()

    await runCommand('folders.expandAll', 'palette')
    expect(tree.expandAll).toHaveBeenCalledTimes(1)
    expect(onFoldersExpandedChange).toHaveBeenLastCalledWith(true)

    await runCommand('folders.collapseAll', 'palette')
    expect(tree.collapseAll).toHaveBeenCalledTimes(1)
    expect(onFoldersExpandedChange).toHaveBeenLastCalledWith(false)
  })

  it('creates a project and a canvas through the sidebar creators', async () => {
    mount()
    await runCommand('create.project', 'palette')
    await runCommand('create.canvas', 'palette')

    expect(createProject).toHaveBeenCalledTimes(1)
    expect(createCanvas).toHaveBeenCalledTimes(1)
  })

  it('leaves the tree commands out while the tree is not on screen, but not the creators', () => {
    mount({ isTreeVisible: false })

    expect(isCommandAvailable('create.folder')).toBe(false)
    expect(isCommandAvailable('folders.expandAll')).toBe(false)
    expect(isCommandAvailable('folders.collapseAll')).toBe(false)
    expect(isCommandAvailable('create.project')).toBe(true)
  })

  it('leaves canvas out while the canvas feature is off', () => {
    mount({ isCanvasEnabled: false })
    expect(isCommandAvailable('create.canvas')).toBe(false)
  })
})
