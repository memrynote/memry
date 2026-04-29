import { describe, expect, it, beforeAll, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { SettingsModalProvider } from '@/contexts/settings-modal-context'

vi.mock('./account-section', () => ({ AccountSettings: () => <div data-testid="account-panel" /> }))
vi.mock('./general-section', () => ({ GeneralSettings: () => <div /> }))
vi.mock('./templates-section', () => ({ TemplatesSettings: () => <div /> }))
vi.mock('./editor-section', () => ({ EditorSettings: () => <div /> }))
vi.mock('./journal-section', () => ({ JournalSettings: () => <div /> }))
vi.mock('./tasks-section', () => ({ TasksSettings: () => <div /> }))
vi.mock('./calendar-section', () => ({ CalendarSettingsSection: () => <div /> }))
vi.mock('./vault-section', () => ({ VaultSettings: () => <div /> }))
vi.mock('./appearance-section', () => ({ AppearanceSettings: () => <div /> }))
vi.mock('./ai-section', () => ({ AISettings: () => <div /> }))
vi.mock('./integrations-section', () => ({ IntegrationsSettings: () => <div /> }))
vi.mock('./tags-section', () => ({ TagsSettings: () => <div /> }))
vi.mock('./properties-section', () => ({ PropertiesSettings: () => <div /> }))
vi.mock('./shortcuts-section', () => ({ ShortcutsSettings: () => <div /> }))

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

    expect(screen.getByText('Settings')).toBeInTheDocument()

    for (const label of ['Workspace', 'Preferences', 'Services', 'Data']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

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
      'AI Assistant',
      'Integrations',
      'Vault',
      'Tags',
      'Properties'
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })
})
