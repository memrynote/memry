import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
})
