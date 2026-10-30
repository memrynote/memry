import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { CustomIconGrid } from './CustomIconGrid'

const addFromUrl = vi.hoisted(() => vi.fn())

vi.mock('@/lib/custom-icons-store', () => ({
  useCustomIcons: () => [],
  refreshCustomIcons: vi.fn(async () => {})
}))

vi.mock('@/services/custom-icons-service', () => ({
  customIconsService: { addFromUrl }
}))

let i18n: I18nInstance

beforeAll(async () => {
  i18n = await createRendererI18n({ locale: 'en' })
})

beforeEach(() => {
  vi.clearAllMocks()
  addFromUrl.mockResolvedValue({ id: 'icon-1' })
})

const renderGrid = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <CustomIconGrid onSelect={vi.fn()} />
    </I18nextProvider>
  )

describe('CustomIconGrid link input', () => {
  it('hands the link to the download command and clears the field', async () => {
    const user = userEvent.setup()
    renderGrid()

    const input = screen.getByLabelText('Image link')
    await user.type(input, 'https://example.com/star.png{Enter}')

    await waitFor(() => expect(addFromUrl).toHaveBeenCalledWith('https://example.com/star.png'))
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('shows the failure and keeps the link so it can be retried', async () => {
    addFromUrl.mockRejectedValue(new Error('That image could not be downloaded.'))
    const user = userEvent.setup()
    renderGrid()

    const input = screen.getByLabelText('Image link')
    await user.type(input, 'https://example.com/gone.png')
    await user.click(screen.getByLabelText('Download this image'))

    expect(await screen.findByText('That image could not be downloaded.')).toBeInTheDocument()
    expect(input).toHaveValue('https://example.com/gone.png')
  })

  it('ignores an empty field', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.type(screen.getByLabelText('Image link'), '   {Enter}')

    expect(addFromUrl).not.toHaveBeenCalled()
  })
})
