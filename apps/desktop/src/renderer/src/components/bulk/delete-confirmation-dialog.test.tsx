import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { DeleteConfirmationDialog } from './delete-confirmation-dialog'

describe('DeleteConfirmationDialog (i18n)', () => {
  let i18nEn: I18nInstance
  let i18nTr: I18nInstance

  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
    i18nTr = await createRendererI18n({ locale: 'tr' })
  })

  it('renders English Cancel + "Delete 5 items" for itemCount=5', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    expect(screen.getByText('Delete 5 items')).toBeInTheDocument()
  })

  it('renders English "Delete 1 item" (singular) for itemCount=1', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={1}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('Delete 1 item')).toBeInTheDocument()
  })

  it('renders Turkish "İptal" + "5 öğeyi sil" when locale is tr', () => {
    render(
      <I18nextProvider i18n={i18nTr}>
        <DeleteConfirmationDialog
          isOpen={true}
          itemCount={5}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nextProvider>
    )
    expect(screen.getByText('İptal')).toBeInTheDocument()
    expect(screen.getByText('5 öğeyi sil')).toBeInTheDocument()
  })
})
