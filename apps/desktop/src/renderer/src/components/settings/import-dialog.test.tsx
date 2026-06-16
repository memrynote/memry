import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ImportDialog } from './import-dialog'
import { DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'
import type { ImporterItem } from '@/hooks/use-importers'

const notionItem: ImporterItem = {
  id: 'notion',
  name: 'Notion',
  descriptionKey: 'import.sources.notion',
  fileSpec: { label: 'Notion HTML export', extensions: ['zip'], allowMultiple: true },
  supportsPreview: false,
  icon: DEFAULT_IMPORT_ICON
}

describe('ImportDialog i18n', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: {
        pickFiles: () => {},
        start: () => {},
        cancel: () => {},
        preview: () => {},
        list: () => {}
      }
    }
  })

  it('interpolates the ICU title and description (no literal braces)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ImportDialog item={notionItem} open onOpenChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Import from Notion')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{?name\}?\}/)).toBeNull()
  })
})
