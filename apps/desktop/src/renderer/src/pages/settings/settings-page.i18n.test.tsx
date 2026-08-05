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
vi.mock('./integrations-section', () => ({
  IntegrationsSettings: () => <div data-testid="integrations-panel" />
}))
vi.mock('./tags-section', () => ({ TagsSettings: () => <div data-testid="tags-panel" /> }))
vi.mock('./properties-section', () => ({
  PropertiesSettings: () => <div data-testid="properties-panel" />
}))
vi.mock('./shortcuts-section', () => ({
  ShortcutsSettings: () => <div data-testid="shortcuts-panel" />
}))
vi.mock('./command-line-section', () => ({
  CommandLineSettings: () => <div data-testid="command-line-panel" />
}))

import { SettingsPage } from '../settings'

describe('SettingsPage i18n', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  it('renders shell labels from the settings namespace', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SettingsModalProvider>
          <SettingsPage />
        </SettingsModalProvider>
      </I18nextProvider>
    )

    expect(screen.queryByText('Settings')).not.toBeInTheDocument()

    for (const label of ['Application', 'Editing', 'Modules', 'Services', 'Data']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

    // 'Account' is both a group label and a nav item
    expect(screen.getAllByText('Account')).toHaveLength(2)

    for (const label of [
      'Account',
      'General',
      'Templates',
      'Editor',
      'Journal',
      'Tasks',
      'Calendar',
      'Appearance',
      'Shortcuts',
      'Command Line',
      'AI Assistant',
      'Integrations',
      'Vault',
      'Tags',
      'Properties'
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    expect(screen.queryByRole('button', { name: 'Agent Providers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Agent MCP' })).not.toBeInTheDocument()
  })

  it('switches every settings section from the sidebar', async () => {
    const user = userEvent.setup()

    render(
      <I18nextProvider i18n={i18n}>
        <SettingsModalProvider>
          <SettingsPage />
        </SettingsModalProvider>
      </I18nextProvider>
    )

    expect(screen.getByTestId('account-panel')).toBeInTheDocument()

    for (const [label, panelId] of [
      ['General', 'general-panel'],
      ['Templates', 'templates-panel'],
      ['Editor', 'editor-panel'],
      ['Journal', 'journal-panel'],
      ['Tasks', 'tasks-panel'],
      ['Calendar', 'calendar-panel'],
      ['Appearance', 'appearance-panel'],
      ['Shortcuts', 'shortcuts-panel'],
      ['Command Line', 'command-line-panel'],
      ['AI Assistant', 'ai-panel'],
      ['Integrations', 'integrations-panel'],
      ['Vault', 'vault-panel'],
      ['Tags', 'tags-panel'],
      ['Properties', 'properties-panel'],
      ['Account', 'account-panel']
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }))
      expect(screen.getByTestId(panelId)).toBeInTheDocument()
    }
  })
})
