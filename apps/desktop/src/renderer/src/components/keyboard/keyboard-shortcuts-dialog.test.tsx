import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog'

vi.mock('@memry/i18n/renderer', () => {
  const groupTitles: Record<string, string> = {
    'shortcuts.groups.general.title': 'General',
    'shortcuts.groups.tabs.title': 'Tabs & Splits',
    'shortcuts.groups.inbox.title': 'Inbox',
    'shortcuts.groups.journal.title': 'Journal',
    'shortcuts.groups.notes.title': 'Notes / Editor',
    'shortcuts.groups.tasks.title': 'Tasks',
    'shortcuts.groups.settings.title': 'Settings'
  }

  return {
    useT: () => ({
      t: (key: string) => {
        if (key.endsWith('keyboardShortcuts')) return 'Keyboard Shortcuts'
        if (key.endsWith('press')) return 'Press'
        if (key.endsWith('toToggleThisDialog')) return 'to open and close this dialog'
        return groupTitles[key] ?? key
      }
    })
  }
})

describe('KeyboardShortcutsDialog', () => {
  afterEach(() => {
    __setShortcutOverridesForTests({})
  })

  it('renders the full shortcut section catalog', () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    for (const section of [
      'General',
      'Tabs & Splits',
      'Inbox',
      'Journal',
      'Notes / Editor',
      'Tasks',
      'Settings'
    ]) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument()
    }
  })

  it('renders readable key chips for the global help shortcut', () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })

    expect(within(dialog).getAllByText('?').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('/').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText(/⌘|Ctrl/).length).toBeGreaterThan(0)
  })

  it('shows a rebound chord instead of the default', () => {
    __setShortcutOverridesForTests({
      'tabs.splitRight': { key: 'y', modifiers: { meta: true, alt: true } }
    })

    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    const row = screen.getByText('shortcuts.items.tabs.splitRight').closest('div')!.parentElement!
    expect(within(row).getByText('Y')).toBeInTheDocument()
    expect(within(row).queryByText('\\')).toBeNull()
  })

  it('does not advertise shortcuts nothing handles', () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    for (const phantom of [
      'shortcuts.items.journal.toggleFullWidth',
      'shortcuts.items.journal.link',
      'shortcuts.items.notes.saveNote',
      'shortcuts.items.notes.link'
    ]) {
      expect(screen.queryByText(phantom)).toBeNull()
    }
  })
})
