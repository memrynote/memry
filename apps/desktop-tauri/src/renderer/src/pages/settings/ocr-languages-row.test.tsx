import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { OcrLanguagesState } from '@memry/contracts/ocr-languages-api'
import { createRendererI18n } from '@memry/i18n/renderer'
import type * as Bindings from '../../../../generated/bindings'
import { OcrLanguagesRow } from './ocr-languages-row'

const englishOnly: OcrLanguagesState = { selected: ['eng'], statuses: { eng: { state: 'ready' } } }

const ipc = vi.hoisted(() => ({
  commands: {
    ocrLanguagesGetState: vi.fn(),
    ocrLanguagesSet: vi.fn(),
    ocrLanguagesRetry: vi.fn()
  },
  changed: null as null | ((event: { payload: OcrLanguagesState }) => void)
}))
vi.mock('../../../../generated/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof Bindings>()
  return {
    ...actual,
    commands: { ...actual.commands, ...ipc.commands },
    events: {
      ...actual.events,
      ocrLanguagesChangedEvent: {
        listen: (handler: (event: { payload: OcrLanguagesState }) => void) => {
          ipc.changed = handler
          return Promise.resolve(() => {})
        }
      }
    }
  }
})
const changed = (state: OcrLanguagesState) => ipc.changed?.({ payload: state })

describe('OcrLanguagesRow', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
    for (const method of [
      'hasPointerCapture',
      'setPointerCapture',
      'releasePointerCapture'
    ] as const) {
      HTMLElement.prototype[method] ??= vi.fn(() => false) as never
    }
    HTMLElement.prototype.scrollIntoView ??= vi.fn()
    ipc.commands.ocrLanguagesGetState.mockResolvedValue(englishOnly)
    ipc.commands.ocrLanguagesSet.mockReset().mockResolvedValue(englishOnly)
    ipc.commands.ocrLanguagesRetry.mockReset().mockResolvedValue(englishOnly)
  })

  const renderRow = () =>
    render(
      <I18nextProvider i18n={i18n}>
        <OcrLanguagesRow />
      </I18nextProvider>
    )

  it('adds a language to the ones already chosen, with English always on', async () => {
    const user = userEvent.setup()
    renderRow()

    await user.click(await screen.findByTestId('ocr-languages-trigger'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'English' })).toHaveAttribute(
      'data-disabled'
    )
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Deutsch' }))

    expect(ipc.commands.ocrLanguagesSet).toHaveBeenCalledWith(['eng', 'deu'])
  })

  it('shows download progress, then a failed download with its reason and a retry', async () => {
    const user = userEvent.setup()
    renderRow()
    await screen.findByTestId('ocr-languages-trigger')

    act(() =>
      changed({
        selected: ['eng', 'deu'],
        statuses: {
          eng: { state: 'ready' },
          deu: { state: 'downloading', receivedBytes: 512, totalBytes: 1024 }
        }
      })
    )
    expect(screen.getByText('Downloading Deutsch: 50%')).toBeInTheDocument()
    expect(screen.getByTestId('ocr-languages-trigger')).toHaveTextContent('English, Deutsch')

    act(() =>
      changed({
        selected: ['eng', 'deu'],
        statuses: {
          eng: { state: 'ready' },
          deu: { state: 'failed', error: 'errors:ocrLanguages.unreachable' }
        }
      })
    )
    expect(
      screen.getByText(
        "Deutsch: Memry's server could not be reached. The languages already here keep working, and Memry tries again at the next start."
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(ipc.commands.ocrLanguagesRetry).toHaveBeenCalledTimes(1))
  })
})
