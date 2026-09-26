import { describe, expect, it, beforeAll, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { SettingsModalProvider } from '@/contexts/settings-modal-context'

vi.mock('./account-section', () => ({ AccountSettings: () => <div data-testid="account-panel" /> }))
vi.mock('./general-section', () => ({ GeneralSettings: () => <div data-testid="general-panel" /> }))
vi.mock('./templates-section', () => ({
  TemplatesSettings: () => <div data-testid="templates-panel" />
}))
vi.mock('./editor-section', () => ({ EditorSettings: () => <div data-testid="editor-panel" /> }))
vi.mock('./journal-section', () => ({ JournalSettings: () => <div data-testid="journal-panel" /> }))
vi.mock('./tasks-section', () => ({ TasksSettings: () => <div data-testid="tasks-panel" /> }))
vi.mock('./calendar-section', () => ({
  CalendarSettingsSection: () => <div data-testid="calendar-panel" />
}))
vi.mock('./vault-section', () => ({ VaultSettings: () => <div data-testid="vault-panel" /> }))
vi.mock('./appearance-section', () => ({
  AppearanceSettings: () => <div data-testid="appearance-panel" />
}))
vi.mock('./ai-section', () => ({ AISettings: () => <div data-testid="ai-panel" /> }))
vi.mock('./tags-section', () => ({ TagsSettings: () => <div data-testid="tags-panel" /> }))
vi.mock('./properties-section', () => ({
  PropertiesSettings: () => <div data-testid="properties-panel" />
}))
vi.mock('./shortcuts-section', () => ({
  ShortcutsSettings: () => <div data-testid="shortcuts-panel" />
}))
vi.mock('./inbox-section', () => ({ InboxSettings: () => <div data-testid="inbox-panel" /> }))
vi.mock('./import-section', () => ({ ImportSettings: () => <div data-testid="import-panel" /> }))
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: { home: true, journal: true, tasks: true, inbox: true, calendar: false, graph: true },
    setFlag: vi.fn()
  })
}))
vi.mock('./command-line-section', () => ({
  CommandLineSettings: () => <div data-testid="command-line-panel" />
}))

import { SettingsPage } from '../settings'
import { SettingsModal } from '@/components/settings-modal'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useEffect } from 'react'

function renderPage(ui: React.ReactNode = <SettingsPage />) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SettingsModalProvider>{ui}</SettingsModalProvider>
    </I18nextProvider>
  )
}

let i18n: I18nInstance

describe('SettingsPage', () => {
  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  it('renders the grouped navigation', () => {
    renderPage()

    for (const label of ['Workspace', 'Features', 'Data']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    for (const label of [
      'Account',
      'General',
      'Appearance',
      'Editor',
      'Shortcuts',
      'Modules',
      'AI & Agents',
      'Tags & Properties',
      'Vault & Data',
      'Import'
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Templates' })).not.toBeInTheDocument()
  })

  it('renders merged pages together', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByTestId('account-panel')).toBeInTheDocument()

    for (const [label, panels] of [
      ['General', ['general-panel']],
      ['Appearance', ['appearance-panel']],
      ['Editor', ['editor-panel', 'templates-panel']],
      ['Shortcuts', ['shortcuts-panel']],

      ['AI & Agents', ['ai-panel']],
      ['Tags & Properties', ['tags-panel', 'properties-panel']],
      ['Vault & Data', ['vault-panel']],
      ['Import', ['import-panel']],
      ['Account', ['account-panel']]
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }))
      for (const panel of panels) expect(screen.getByTestId(panel)).toBeInTheDocument()
    }
  })

  it('drills into module settings and back', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Modules' }))
    expect(screen.getByRole('switch', { name: 'Graph' })).toBeInTheDocument()
    // Only modules with their own settings drill in; disabled ones cannot.
    expect(screen.queryByRole('button', { name: 'Configure Graph' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Configure Calendar' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Configure Journal' }))
    expect(screen.getByTestId('journal-panel')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Graph' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Modules' })).toHaveAttribute('aria-current', 'page')

    await user.click(screen.getByRole('button', { name: 'Back to Modules' }))
    expect(screen.getByRole('switch', { name: 'Graph' })).toBeInTheDocument()
  })

  it('opens import as its own page', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByTestId('import-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('vault-panel')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument()
  })

  it('keeps legacy section targets working', () => {
    function OpenLegacy({ section }: { section: string }) {
      const { open } = useSettingsModal()
      useEffect(() => open(section), [open, section])
      return null
    }

    renderPage(
      <>
        <OpenLegacy section="tasks" />
        <SettingsModal />
      </>
    )
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to Modules' })).toBeInTheDocument()
  })

  it('steps back from a drill-in on Escape instead of closing', async () => {
    const user = userEvent.setup()
    function OpenLegacy() {
      const { open } = useSettingsModal()
      useEffect(() => open('tasks'), [open])
      return null
    }

    renderPage(
      <>
        <OpenLegacy />
        <SettingsModal />
      </>
    )
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('switch', { name: 'Graph' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('switch', { name: 'Graph' })).not.toBeInTheDocument()
  })
})
