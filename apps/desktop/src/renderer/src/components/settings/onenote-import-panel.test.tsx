import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { OneNoteNotebookDto } from '@memry/contracts/import-channels'
import { OneNoteImportPanel, type OneNotePanelState } from './onenote-import-panel'

const NOTEBOOKS: OneNoteNotebookDto[] = [
  {
    id: 'nb1',
    displayName: 'Work',
    sections: [{ id: 's1', displayName: 'Ideas' }],
    sectionGroups: [
      {
        id: 'g1',
        displayName: 'Archive',
        sections: [{ id: 's2', displayName: 'Old' }],
        sectionGroups: []
      }
    ]
  }
]

describe('OneNoteImportPanel', () => {
  let i18n: I18nInstance
  let status: ReturnType<typeof vi.fn>
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let notebooks: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    status = vi.fn(() => Promise.resolve({ configured: true, connected: false, account: null }))
    connect = vi.fn(() =>
      Promise.resolve({
        configured: true,
        connected: true,
        account: { name: 'Kaan', email: 'kaan@example.com' }
      })
    )
    disconnect = vi.fn(() => Promise.resolve({ success: true }))
    notebooks = vi.fn(() => Promise.resolve({ notebooks: NOTEBOOKS }))
    ;(window as unknown as { api: unknown }).api = {
      import: { onenote: { status, connect, disconnect, notebooks } }
    }
  })

  const renderPanel = (onStateChange: (state: OneNotePanelState) => void = () => {}) =>
    render(
      <I18nextProvider i18n={i18n}>
        <OneNoteImportPanel disabled={false} onStateChange={onStateChange} />
      </I18nextProvider>
    )

  it('signs in, loads the tree and preselects every section', async () => {
    const states: OneNotePanelState[] = []
    renderPanel((state) => states.push(state))

    const signIn = await screen.findByText('Sign in with Microsoft')
    fireEvent.click(signIn)

    await waitFor(() => expect(connect).toHaveBeenCalled())
    await screen.findByText('Signed in as Kaan (kaan@example.com)')

    // Tree renders notebook, group and both sections.
    await screen.findByText('Work')
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByText('Ideas')).toBeInTheDocument()
    expect(screen.getByText('Old')).toBeInTheDocument()

    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      expect(last.options.sectionIds?.sort()).toEqual(['s1', 's2'])
      expect(last.options.includeIncompatibleAttachments).toBe(false)
      expect(last.options.skipPreviouslyImported).toBe(true)
    })
  })

  it('loads notebooks straight away when already connected', async () => {
    status.mockResolvedValue({
      configured: true,
      connected: true,
      account: { name: 'Kaan', email: 'kaan@example.com' }
    })
    renderPanel()
    await screen.findByText('Ideas')
    expect(connect).not.toHaveBeenCalled()
    expect(notebooks).toHaveBeenCalledTimes(1)
  })

  it('reports not-ready when the selection is cleared and tracks toggles', async () => {
    status.mockResolvedValue({
      configured: true,
      connected: true,
      account: { name: 'Kaan', email: 'kaan@example.com' }
    })
    const states: OneNotePanelState[] = []
    renderPanel((state) => states.push(state))
    await screen.findByText('Ideas')

    fireEvent.click(screen.getByText('Clear selection'))
    await waitFor(() => {
      expect(states[states.length - 1].ready).toBe(false)
    })

    fireEvent.click(screen.getByText('Select all'))
    fireEvent.click(screen.getByText('Import incompatible attachments'))
    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      expect(last.options.includeIncompatibleAttachments).toBe(true)
    })
  })

  it('forgets the account on switch', async () => {
    status.mockResolvedValue({
      configured: true,
      connected: true,
      account: { name: 'Kaan', email: 'kaan@example.com' }
    })
    renderPanel()
    await screen.findByText('Ideas')

    fireEvent.click(screen.getByText('Switch account'))
    await waitFor(() => expect(disconnect).toHaveBeenCalled())
    await screen.findByText('Sign in with Microsoft')
  })
})

describe('OneNoteImportPanel IPC error envelopes', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  it('surfaces a failed sign-in instead of crashing on the envelope', async () => {
    ;(window as unknown as { api: unknown }).api = {
      import: {
        onenote: {
          status: vi.fn(() =>
            Promise.resolve({ configured: true, connected: false, account: null })
          ),
          // registerCommand resolves failures; it never rejects.
          connect: vi.fn(() =>
            Promise.resolve({ success: false, error: 'Microsoft sign-in timed out' })
          ),
          disconnect: vi.fn(),
          notebooks: vi.fn(() => Promise.resolve({ success: false, error: 'nope' }))
        }
      }
    }

    render(
      <I18nextProvider i18n={i18n}>
        <OneNoteImportPanel disabled={false} onStateChange={() => {}} />
      </I18nextProvider>
    )

    fireEvent.click(await screen.findByText('Sign in with Microsoft'))
    await screen.findByText('Microsoft sign-in timed out')
    // The sign-in button stays available; no crash text leaked through.
    expect(screen.getByText('Sign in with Microsoft')).toBeInTheDocument()
    expect(screen.queryByText(/flatMap/)).toBeNull()
  })

  it('keeps the connected state when disconnecting fails', async () => {
    ;(window as unknown as { api: unknown }).api = {
      import: {
        onenote: {
          status: vi.fn(() =>
            Promise.resolve({
              configured: true,
              connected: true,
              account: { name: 'Kaan', email: 'kaan@example.com' }
            })
          ),
          connect: vi.fn(),
          disconnect: vi.fn(() => Promise.resolve({ success: false, error: 'keychain locked' })),
          notebooks: vi.fn(() => Promise.resolve({ notebooks: NOTEBOOKS }))
        }
      }
    }

    render(
      <I18nextProvider i18n={i18n}>
        <OneNoteImportPanel disabled={false} onStateChange={() => {}} />
      </I18nextProvider>
    )

    await screen.findByText('Ideas')
    fireEvent.click(screen.getByText('Switch account'))
    await screen.findByText('keychain locked')
    expect(screen.getByText('Switch account')).toBeInTheDocument()
  })
})
