import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import {
  READWISE_OPTIONS_DEFAULTS,
  type ReadwiseStatusResult
} from '@memry/contracts/import-channels'
import type { OneNotePanelState } from './onenote-import-panel'

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteFoldersQuery: () => ({ folders: [{ path: 'Inbox' }] })
}))

import { ReadwiseImportPanel } from './readwise-import-panel'

const disconnectedStatus: ReadwiseStatusResult = {
  connected: false,
  options: READWISE_OPTIONS_DEFAULTS,
  lastSyncAt: null,
  needsAttention: false,
  runAvailable: true
}
const connectedStatus: ReadwiseStatusResult = { ...disconnectedStatus, connected: true }

describe('ReadwiseImportPanel', () => {
  let i18n: I18nInstance
  let status: ReturnType<typeof vi.fn>
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let setOptions: ReturnType<typeof vi.fn>
  let syncNow: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    status = vi.fn(() => Promise.resolve(disconnectedStatus))
    connect = vi.fn(() => Promise.resolve(connectedStatus))
    disconnect = vi.fn(() => Promise.resolve({ success: true }))
    setOptions = vi.fn(() => Promise.resolve(connectedStatus))
    syncNow = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as unknown as { api: unknown }).api = {
      import: { readwise: { status, connect, disconnect, setOptions, syncNow } }
    }
  })

  const renderPanel = (onStateChange: (state: OneNotePanelState) => void = () => {}) =>
    render(
      <I18nextProvider i18n={i18n}>
        <ReadwiseImportPanel disabled={false} onStateChange={onStateChange} />
      </I18nextProvider>
    )

  it('masks the token, connects through the verified channel, then shows the settings', async () => {
    const states: OneNotePanelState[] = []
    renderPanel((state) => states.push(state))

    const input = await screen.findByLabelText('Access token')
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({ token: 'tok-123' }))
    await screen.findByText('Where notes go')
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument()
    await waitFor(() => expect(states[states.length - 1].ready).toBe(true))
  })

  it('shows the readable error for an invalid token and stays on the connect form', async () => {
    connect.mockResolvedValue({
      success: false,
      error: 'Readwise did not accept this token. Copy it again from readwise.io/access_token.'
    })
    renderPanel()

    fireEvent.change(await screen.findByLabelText('Access token'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('did not accept this token')
    expect(screen.getByLabelText('Access token')).toBeInTheDocument()
    expect(screen.queryByText('Where notes go')).not.toBeInTheDocument()
  })

  it('lists one switch per category with supplementals off, and saves a change', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    const supplementals = await screen.findByRole('switch', { name: 'Supplementals' })
    expect(supplementals).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Books' })).toBeChecked()
    expect(screen.getAllByRole('switch')).toHaveLength(5)

    fireEvent.click(supplementals)
    await waitFor(() =>
      expect(setOptions).toHaveBeenCalledWith({ categories: { supplementals: true } })
    )
  })

  it('saves the folder layout', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    fireEvent.click(await screen.findByRole('radio', { name: 'One folder' }))
    await waitFor(() => expect(setOptions).toHaveBeenCalledWith({ folderLayout: 'flat' }))
  })

  it('disconnects and returns to the connect form', async () => {
    status.mockResolvedValueOnce(connectedStatus).mockResolvedValue(disconnectedStatus)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(disconnect).toHaveBeenCalled())
    await screen.findByLabelText('Access token')
  })

  it('keeps Import and Sync now closed while the run engine is not in the build', async () => {
    status.mockResolvedValue({ ...connectedStatus, runAvailable: false })
    const states: OneNotePanelState[] = []
    renderPanel((state) => states.push(state))

    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled()
    await waitFor(() => expect(states[states.length - 1]).toEqual({ ready: false, options: {} }))
  })

  it('opens the token page through the external-link route', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Get your token' }))
    expect(open).toHaveBeenCalledWith(
      'https://readwise.io/access_token',
      '_blank',
      'noopener,noreferrer'
    )
    open.mockRestore()
  })

  it('shows the error when the status cannot be read', async () => {
    status.mockRejectedValue(new Error('boom'))
    renderPanel()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('syncs now, and shows the failure when a sync or an option save is refused', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(syncNow).toHaveBeenCalled())

    syncNow.mockResolvedValue({ success: false, error: 'sync refused' })
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await screen.findByText('sync refused')).toBeInTheDocument()

    setOptions.mockResolvedValue({ success: false, error: 'save refused' })
    fireEvent.click(screen.getByRole('switch', { name: 'Books' }))
    expect(await screen.findByText('save refused')).toBeInTheDocument()
  })

  it('shows the failure when disconnecting is refused and stays connected', async () => {
    status.mockResolvedValue(connectedStatus)
    disconnect.mockResolvedValue({ success: false, error: 'cannot disconnect' })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('cannot disconnect')).toBeInTheDocument()
    expect(screen.getByText('Where notes go')).toBeInTheDocument()
  })

  it('connects on Enter, and tells the user when the saved root folder no longer exists', async () => {
    renderPanel()
    const input = await screen.findByLabelText('Access token')
    fireEvent.change(input, { target: { value: 'tok-1' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ token: 'tok-1' }))
  })

  it('lists a saved root folder that is not among the vault folders, and changes cadence', async () => {
    status.mockResolvedValue({
      ...connectedStatus,
      options: { ...READWISE_OPTIONS_DEFAULTS, rootFolder: 'Gone/Away' }
    })
    renderPanel()
    expect(await screen.findByText('/Gone/Away')).toBeInTheDocument()
  })

  it('shows the needs-attention line instead of the sync hint', async () => {
    status.mockResolvedValue({ ...connectedStatus, needsAttention: true })
    renderPanel()
    expect(await screen.findByText(/needs your attention/)).toBeInTheDocument()
  })
})
