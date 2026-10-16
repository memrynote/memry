import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'
import { SHORTCUT_ENTRIES } from '@/lib/shortcut-catalog'
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog'

vi.mock('@memry/i18n/renderer', () => {
  const groupTitles: Record<string, string> = {
    'shortcuts.categories.navigation': 'Navigation',
    'shortcuts.categories.tabs': 'Tabs',
    'shortcuts.categories.editor': 'Editor',
    'shortcuts.categories.view': 'View',
    'shortcuts.groups.inbox.title': 'Inbox',
    'shortcuts.groups.journal.title': 'Journal',
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
      'Navigation',
      'Tabs',
      'Editor',
      'View',
      'Inbox',
      'Journal',
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

    const row = screen
      .getByText('shortcuts.entries.tabs.splitRight.label')
      .closest('div')!.parentElement!
    expect(within(row).getByText('Y')).toBeInTheDocument()
    expect(within(row).queryByText('\\')).toBeNull()
  })

  it('lists every command that has a keyboard entry', () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    const missing = SHORTCUT_ENTRIES.filter(
      ({ i18nKey }) => screen.queryAllByText(`shortcuts.entries.${i18nKey}.label`).length !== 1
    ).map(({ id }) => id)

    expect(SHORTCUT_ENTRIES.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })

  it('lists the ? alias next to the shortcuts command and drops it for a whileDefault alias once rebound', () => {
    __setShortcutOverridesForTests({
      'view.zoomIn': { key: 'y', modifiers: { meta: true } }
    })
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />)

    const helpRow = screen
      .getByText('shortcuts.entries.view.shortcuts.label')
      .closest('div')!.parentElement!
    expect(within(helpRow).getByText('?')).toBeInTheDocument()

    const zoomRow = screen
      .getByText('shortcuts.entries.view.zoomIn.label')
      .closest('div')!.parentElement!
    expect(within(zoomRow).getByText('Y')).toBeInTheDocument()
    expect(within(zoomRow).queryByText('+')).toBeNull()
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
