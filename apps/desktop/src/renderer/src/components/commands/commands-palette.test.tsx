import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOURCES } from '@memry/i18n/locales'
import { publishActiveContext, registerCommands, resetCommandStoreForTests } from '@/commands/store'
import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import { trackTelemetry } from '@/lib/telemetry'
import { COMMAND_RECENTS_KEY } from './command-recents'
import { CommandsPalette } from './commands-palette'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))
vi.mock('@memry/i18n/renderer', () => ({
  // The real English strings, so the tests read what the user reads.
  useT: (namespace: keyof typeof RESOURCES.en) => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const text = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
          RESOURCES.en[namespace]
        )
      if (typeof text !== 'string') return key
      return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    },
    i18n: { resolvedLanguage: 'en', language: 'en' }
  })
}))

const runs = {
  toggleSidebar: vi.fn(),
  goInbox: vi.fn(),
  pin: vi.fn(),
  find: vi.fn(),
  exportPdf: vi.fn(),
  search: vi.fn()
}

/** Stands in for the owners the palette lists; each is registered where the app registers it. */
function Owners({
  onProject,
  folderTab
}: {
  onProject: () => void
  /** Registers the folder view's owner for the active tab, shown as this tab type. */
  folderTab?: 'folder' | 'tag'
}): null {
  useEffect(() => {
    const undo = [
      registerCommands('sidebar', 'sidebar', () => ({
        'view.toggleSidebar': { run: runs.toggleSidebar }
      })),
      registerCommands('pages', 'pages', () => ({ 'go.inbox': { run: runs.goInbox } })),
      registerCommands('sidebarTree', 'sidebarTree', () => ({
        'create.project': { run: onProject }
      })),
      registerCommands('shell', 'shell', () => ({ 'nav.search': { run: runs.search } })),
      registerCommands('tabs', 'tabs', () => ({
        'tabs.pinTab': { label: 'Unpin Tab', run: runs.pin }
      })),
      folderTab
        ? registerCommands('folder', 'tab-1', () => ({
            'folder.newNote': { run: vi.fn() },
            'folder.renameTag': { run: vi.fn() }
          }))
        : registerCommands('note', 'tab-1', () => ({
            'note.find': { run: runs.find },
            'note.exportPdf': { run: runs.exportPdf }
          }))
    ]
    publishActiveContext({
      activeTabId: 'tab-1',
      activeGroupId: 'group-1',
      activeTabType: folderTab ?? 'note'
    })
    return () => {
      undo.forEach((fn) => fn())
    }
  }, [onProject, folderTab])
  return null
}

/** What a ⌘P press does, for the tests that need focus to be somewhere before it opens. */
let openPalette: () => void = () => {}

function Harness({
  onOpenChange,
  initiallyOpen = true,
  folderTab
}: {
  onOpenChange?: (open: boolean) => void
  initiallyOpen?: boolean
  folderTab?: 'folder' | 'tag'
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  const [projectOpen, setProjectOpen] = useState(false)
  useEffect(() => {
    openPalette = () => {
      setOpen(true)
    }
  }, [])
  return (
    <>
      <button type="button">Editor</button>
      <Owners
        onProject={() => {
          setProjectOpen(true)
        }}
        folderTab={folderTab}
      />
      <CommandsPalette
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          onOpenChange?.(next)
        }}
      />
      {/* Not a focus-trapping dialog: nothing but the order of events keeps its focus. */}
      {projectOpen && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- manually positioned popover surface; native <dialog> top-layer behavior would change stacking and focus handling
        <div role="dialog" aria-label="Project">
          <input aria-label="Project name" autoFocus />
        </div>
      )}
    </>
  )
}

const input = (): HTMLInputElement => screen.getByRole('combobox')
const rowNames = (): string[] =>
  screen.getAllByRole('option').map((row) => row.textContent?.replace(/\s+/g, ' ') ?? '')

beforeEach(() => {
  // jsdom has none; cmdk scrolls the selected row into view.
  Element.prototype.scrollIntoView = vi.fn()
  resetCommandStoreForTests()
  localStorage.clear()
  __setShortcutOverridesForTests({})
  vi.clearAllMocks()
})

describe('CommandsPalette', () => {
  it('lists the active tab first, then the rest by group, with each command bound key', () => {
    render(<Harness />)

    const names = rowNames()
    expect(names.slice(0, 2)).toEqual(['Export to PDF…', 'Find'])
    expect(screen.getByText('This note')).toBeInTheDocument()
    expect(names).toContain('Toggle SidebarCtrlB')
    expect(names).toContain('Go to Inbox')
    // No owner is mounted for sync, so it is not offered.
    expect(names.join()).not.toContain('Sync Now')
    // It does not list itself.
    expect(names.join()).not.toContain('Command Palette')
  })

  it.each([
    ['folder', 'This folder', 'This tag'],
    ['tag', 'This tag', 'This folder']
  ] as const)('names a %s tab by what it shows', (tabType, heading, other) => {
    render(<Harness folderTab={tabType} />)

    expect(screen.getByText(heading)).toBeInTheDocument()
    expect(screen.queryByText(other)).not.toBeInTheDocument()
  })

  it('shows the label an owner gives for the state it is in', () => {
    render(<Harness />)
    expect(rowNames()).toContain('Unpin TabCtrlShiftP')
  })

  it('shows a rebound key, and the new default when the user has none', () => {
    __setShortcutOverridesForTests({
      'view.toggleSidebar': { key: 'j', modifiers: { meta: true } }
    })
    render(<Harness />)
    expect(rowNames()).toContain('Toggle SidebarCtrlJ')
  })

  it('offers search from ⌘K for people who learned ⌘P as search', async () => {
    render(<Harness />)
    const user = userEvent.setup()

    expect(screen.getByRole('button', { name: /Search notes\s*Ctrl\+K/ })).toBeInTheDocument()

    await user.type(input(), 'meeting notes')
    expect(screen.getByText('No commands match “meeting notes”')).toBeInTheDocument()
    expect(screen.getByText('Search notes: Ctrl+K')).toBeInTheDocument()
  })

  it('tracks one open, on the app surface', () => {
    render(<Harness />)
    expect(trackTelemetry).toHaveBeenCalledTimes(1)
    expect(trackTelemetry).toHaveBeenCalledWith('command_palette_opened', {
      surface: 'app',
      action: 'opened',
      objectType: 'commands'
    })
  })

  it('finds a command from part of a word and runs it on Enter, after closing', async () => {
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    const user = userEvent.setup()

    await user.type(input(), 'side')
    expect(rowNames()[0]).toBe('Toggle SidebarCtrlB')
    await user.keyboard('{Enter}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => {
      expect(runs.toggleSidebar).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(COMMAND_RECENTS_KEY) ?? '[]')).toEqual([
      'view.toggleSidebar'
    ])
  })

  it('lists a recent command under Recent next time', async () => {
    localStorage.setItem(COMMAND_RECENTS_KEY, JSON.stringify(['go.inbox', 'gone.command']))
    render(<Harness />)

    const recent = screen.getByText('Recent').closest('[cmdk-group]') as HTMLElement
    expect(
      within(recent)
        .getAllByRole('option')
        .map((row) => row.textContent)
    ).toEqual(['Go to Inbox'])
  })

  it('runs the pick once the palette is gone and focus is back where the user was', async () => {
    render(<Harness initiallyOpen={false} />)
    const user = userEvent.setup()
    const editor = screen.getByRole('button', { name: 'Editor' })
    act(() => {
      editor.focus()
    })
    act(() => {
      openPalette()
    })

    const seen: { paletteOpen: boolean; focus: Element | null }[] = []
    runs.toggleSidebar.mockImplementation(() =>
      seen.push({
        paletteOpen: screen.queryByRole('combobox') !== null,
        focus: document.activeElement
      })
    )
    await user.type(input(), 'side')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(seen).toHaveLength(1)
    })
    expect(seen[0]).toEqual({ paletteOpen: false, focus: editor })
  })

  it('hands focus to what the command opens, instead of taking it back', async () => {
    render(<Harness initiallyOpen={false} />)
    const user = userEvent.setup()
    act(() => {
      screen.getByRole('button', { name: 'Editor' }).focus()
    })
    act(() => {
      openPalette()
    })

    await user.type(input(), 'new proj')
    await user.keyboard('{Enter}')

    const field = await screen.findByLabelText('Project name')
    await waitFor(() => {
      expect(field).toHaveFocus()
    })
    // Past anything the palette's own close could still do.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(field).toHaveFocus()
  })

  it('puts focus back where the user was when it is dismissed', async () => {
    render(<Harness initiallyOpen={false} />)
    const user = userEvent.setup()
    const editor = screen.getByRole('button', { name: 'Editor' })
    act(() => {
      editor.focus()
    })
    act(() => {
      openPalette()
    })

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(editor).toHaveFocus()
    })
  })

  it('runs nothing when dismissed with Escape', async () => {
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    const user = userEvent.setup()

    await user.type(input(), 'side')
    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(runs.toggleSidebar).not.toHaveBeenCalled()
    expect(localStorage.getItem(COMMAND_RECENTS_KEY)).toBeNull()
  })

  it('opens search from its footer, once it has closed', async () => {
    render(<Harness />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Search notes/ }))

    await waitFor(() => {
      expect(runs.search).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
