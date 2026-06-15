import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ImportDialog } from './import-dialog'
import { IMPORT_CATALOG } from '@/lib/import-catalog'

describe('ImportDialog i18n', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: { pickFiles: () => {}, start: () => {}, cancel: () => {} }
    }
  })

  it('interpolates the ICU title and description (no literal braces)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ImportDialog item={IMPORT_CATALOG[0]} open onOpenChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Import from Notion')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{?name\}?\}/)).toBeNull()
  })
})
