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
  hasImported: false,
  thisDevicePulls: true,
  pullingDeviceName: null,
  syncing: null,
  lastRun: null,
  error: null,
  nextRunAt: null
}
/** Connected after a first run: the panel shows the settings, not the preview. */
const connectedStatus: ReadwiseStatusResult = {
  ...disconnectedStatus,
  connected: true,
  hasImported: true
}
const firstImportStatus: ReadwiseStatusResult = { ...connectedStatus, hasImported: false }

describe('ReadwiseImportPanel', () => {
  let i18n: I18nInstance
  let status: ReturnType<typeof vi.fn>
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let setOptions: ReturnType<typeof vi.fn>
  let syncNow: ReturnType<typeof vi.fn>
  let listDeleted: ReturnType<typeof vi.fn>
  let restoreBook: ReturnType<typeof vi.fn>
  let takeOver: ReturnType<typeof vi.fn>
  let cancel: ReturnType<typeof vi.fn>
  let statusListeners: Array<() => void>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    status = vi.fn(() => Promise.resolve(disconnectedStatus))
    connect = vi.fn(() => Promise.resolve(connectedStatus))
    disconnect = vi.fn(() => Promise.resolve({ success: true }))
    setOptions = vi.fn(() => Promise.resolve(connectedStatus))
    syncNow = vi.fn(() => Promise.resolve({ success: true }))
    listDeleted = vi.fn(() => Promise.resolve({ books: [] }))
    restoreBook = vi.fn(() => Promise.resolve({ success: true }))
    takeOver = vi.fn(() => Promise.resolve(connectedStatus))
    cancel = vi.fn(() => Promise.resolve({ success: true }))
    statusListeners = []
    ;(window as unknown as { api: unknown }).api = {
      onReadwiseStatusChanged: (callback: () => void) => {
        statusListeners.push(callback)
        return () => {
          statusListeners = statusListeners.filter((listener) => listener !== callback)
        }
      },
      import: {
        readwise: {
          status,
          connect,
          disconnect,
          setOptions,
          syncNow,
          listDeleted,
          restoreBook,
          takeOver,
          cancel
        }
      }
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

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({ token: 'tok-123' })
    })
    await screen.findByText('Where notes go')
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(states[states.length - 1].ready).toBe(true)
    })
  })

  it('names the pulling device and takes over with the token pasted again (D8)', async () => {
    status.mockResolvedValue({
      ...disconnectedStatus,
      thisDevicePulls: false,
      pullingDeviceName: 'Desk Mac'
    })
    renderPanel()

    expect(await screen.findByText('Syncs on Desk Mac')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    // The banner offers the takeover; the token form opens from it.
    fireEvent.click(screen.getByRole('button', { name: 'Sync here instead' }))
    const button = screen.getByRole('button', { name: 'Sync here instead' })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tok-9' } })
    fireEvent.click(button)

    await waitFor(() => {
      expect(takeOver).toHaveBeenCalledWith({ token: 'tok-9' })
    })
    await screen.findByText('Where notes go')
  })

  it('shows why a takeover failed and keeps the form', async () => {
    status.mockResolvedValue({
      ...disconnectedStatus,
      thisDevicePulls: false,
      pullingDeviceName: null
    })
    takeOver.mockResolvedValue({ success: false, error: 'Turn on sync to move Readwise.' })
    renderPanel()

    expect(await screen.findByText('Syncs on another device')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Sync here instead' }))
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tok-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sync here instead' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Turn on sync')
    expect(screen.getByLabelText('Access token')).toBeInTheDocument()
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
    expect(screen.getAllByRole('switch')).toHaveLength(8)

    fireEvent.click(supplementals)
    await waitFor(() => {
      expect(setOptions).toHaveBeenCalledWith({ categories: { supplementals: true } })
    })
  })

  it('groups the two Reader switches, both off, and saves each', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    expect(await screen.findByText('Readwise Reader')).toBeInTheDocument()
    expect(screen.getByText('Off by default. Can add thousands of notes.')).toBeInTheDocument()
    expect(screen.getByText('Written once, when the note is created')).toBeInTheDocument()
    const documents = screen.getByRole('switch', { name: 'Also import saved Reader documents' })
    const fullText = screen.getByRole('switch', { name: 'Include full article text' })
    expect(documents).not.toBeChecked()
    expect(fullText).not.toBeChecked()

    fireEvent.click(documents)
    await waitFor(() => {
      expect(setOptions).toHaveBeenCalledWith({ readerDocuments: true })
    })
    fireEvent.click(fullText)
    await waitFor(() => {
      expect(setOptions).toHaveBeenCalledWith({ readerFullText: true })
    })
  })

  it('lists the journal switch, off, and saves it (#3476)', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    expect(await screen.findByText('Journal')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Adds a Readwise section to the day you highlighted, linking each book note. New highlights only, no backfill.'
      )
    ).toBeInTheDocument()
    const journal = screen.getByRole('switch', {
      name: "List each day's highlights in the journal"
    })
    expect(journal).not.toBeChecked()

    fireEvent.click(journal)
    await waitFor(() => {
      expect(setOptions).toHaveBeenCalledWith({ journalHighlights: true })
    })
  })

  it('saves the folder layout', async () => {
    status.mockResolvedValue(connectedStatus)
    renderPanel()

    fireEvent.click(await screen.findByRole('radio', { name: 'One folder' }))
    await waitFor(() => {
      expect(setOptions).toHaveBeenCalledWith({ folderLayout: 'flat' })
    })
  })

  it('disconnects and returns to the connect form', async () => {
    status.mockResolvedValueOnce(connectedStatus).mockResolvedValue(disconnectedStatus)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(disconnect).toHaveBeenCalled()
    })
    await screen.findByLabelText('Access token')
  })

  it('is ready to import once connected, with Sync now enabled', async () => {
    status.mockResolvedValue(connectedStatus)
    const states: OneNotePanelState[] = []
    renderPanel((state) => states.push(state))

    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeEnabled()
    await waitFor(() => {
      expect(states[states.length - 1]).toEqual({
        ready: true,
        options: {},
        confirmLabel: undefined
      })
    })
  })

  describe('first import preview', () => {
    const group = (label: string, books: number, highlights: number) => ({
      label,
      counts: [
        { labelKey: 'import.preview.readwise.books', value: books },
        { labelKey: 'import.preview.readwise.highlights', value: highlights }
      ]
    })
    const libraryPreview = {
      success: true,
      preview: {
        groups: [
          group('books', 124, 900),
          group('articles', 311, 1000),
          group('tweets', 58, 100),
          group('podcasts', 12, 24),
          group('supplementals', 40, 0)
        ]
      }
    }
    let preview: ReturnType<typeof vi.fn>
    let cancel: ReturnType<typeof vi.fn>

    beforeEach(() => {
      status.mockResolvedValue(firstImportStatus)
      preview = vi.fn(() => Promise.resolve(libraryPreview))
      cancel = vi.fn(() => Promise.resolve())
      ;(window as unknown as { api: { import: Record<string, unknown> } }).api.import.preview =
        preview
      ;(window as unknown as { api: { import: Record<string, unknown> } }).api.import.cancel =
        cancel
    })

    it('shows a count per category, and the books the enabled ones will import', async () => {
      const states: OneNotePanelState[] = []
      renderPanel((state) => states.push(state))

      expect(
        await screen.findByText(/2,?024 highlights across 505 books are ready|are ready/)
      ).toBeInTheDocument()
      expect(preview).toHaveBeenCalledWith(
        expect.objectContaining({ importerId: 'readwise', sourcePaths: [] })
      )
      expect(screen.getByText('311')).toBeInTheDocument()
      expect(
        screen.getByText('Off: Supplementals. 505 books will import.', { exact: false })
      ).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: 'Supplementals' })).not.toBeChecked()
      await waitFor(() => {
        expect(states[states.length - 1]).toEqual({
          ready: true,
          options: {},
          confirmLabel: 'Import 505 books'
        })
      })
    })

    it('a category switch changes what Import will bring in', async () => {
      setOptions.mockResolvedValue({
        ...firstImportStatus,
        options: {
          ...READWISE_OPTIONS_DEFAULTS,
          categories: { ...READWISE_OPTIONS_DEFAULTS.categories, tweets: false }
        }
      })
      const states: OneNotePanelState[] = []
      renderPanel((state) => states.push(state))

      fireEvent.click(await screen.findByRole('switch', { name: 'Tweets' }))

      await waitFor(() => {
        expect(setOptions).toHaveBeenCalledWith({ categories: { tweets: false } })
      })
      await waitFor(() => {
        expect(states[states.length - 1].confirmLabel).toBe('Import 447 books')
      })
      expect(preview).toHaveBeenCalledTimes(1)
    })

    it('offers the journal switch beside the counts and says the first import writes nothing there (#3476)', async () => {
      renderPanel()

      const journal = await screen.findByRole('switch', {
        name: "List each day's highlights in the journal"
      })
      expect(journal).not.toBeChecked()
      expect(
        screen.getByText('The first import writes nothing to the journal.')
      ).toBeInTheDocument()

      fireEvent.click(journal)
      await waitFor(() => {
        expect(setOptions).toHaveBeenCalledWith({ journalHighlights: true })
      })
    })

    it('counts saved Reader documents only with the switch on, and the label says notes', async () => {
      setOptions.mockResolvedValue({
        ...firstImportStatus,
        options: { ...READWISE_OPTIONS_DEFAULTS, readerDocuments: true }
      })
      const states: OneNotePanelState[] = []
      renderPanel((state) => states.push(state))

      const readerSwitch = await screen.findByRole('switch', {
        name: 'Also import saved Reader documents'
      })
      expect(readerSwitch).not.toBeChecked()
      expect(screen.getByText('Off by default. Can add thousands of notes.')).toBeInTheDocument()

      preview.mockResolvedValue({
        success: true,
        preview: {
          groups: [
            ...libraryPreview.preview.groups,
            {
              label: 'reader',
              counts: [{ labelKey: 'import.preview.readwise.documents', value: 8 }]
            }
          ]
        }
      })
      fireEvent.click(readerSwitch)

      await waitFor(() => {
        expect(setOptions).toHaveBeenCalledWith({ readerDocuments: true })
      })
      await waitFor(() => {
        expect(preview).toHaveBeenCalledTimes(2)
      })
      expect(await screen.findByText('8')).toBeInTheDocument()
      await waitFor(() => {
        expect(states[states.length - 1].confirmLabel).toBe('Import 513 notes')
      })
    })

    it('is not ready until the counts arrive, and stops the preview on unmount', async () => {
      preview.mockReturnValue(new Promise(() => {}))
      const states: OneNotePanelState[] = []
      const { unmount } = renderPanel((state) => states.push(state))

      await screen.findByText('Reading your Readwise library…')
      await waitFor(() => {
        expect(states.length).toBeGreaterThan(0)
      })
      expect(states[states.length - 1].ready).toBe(false)
      unmount()
      expect(cancel).toHaveBeenCalledWith({ importId: preview.mock.calls[0][0].importId })
    })

    it('offers a plain Import for an empty library', async () => {
      preview.mockResolvedValue({
        success: true,
        preview: {
          groups: ['books', 'articles', 'tweets', 'podcasts', 'supplementals'].map((c) =>
            group(c, 0, 0)
          )
        }
      })
      const states: OneNotePanelState[] = []
      renderPanel((state) => states.push(state))

      await screen.findByText(/has no highlights yet/)
      await waitFor(() => {
        expect(states[states.length - 1]).toEqual({
          ready: true,
          options: {},
          confirmLabel: 'Import'
        })
      })
    })

    it('shows a token problem from the preview and retries on request', async () => {
      preview.mockResolvedValueOnce({
        success: true,
        preview: {
          groups: [
            {
              label: 'Readwise',
              counts: [],
              error: { code: 'readwise.tokenInvalid', message: 'Readwise rejected the token' }
            }
          ]
        }
      })
      const states: OneNotePanelState[] = []
      renderPanel((state) => states.push(state))

      expect(await screen.findByRole('alert')).toHaveTextContent('did not accept the stored token')
      expect(states[states.length - 1].ready).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await screen.findByText('311')
      expect(preview).toHaveBeenCalledTimes(2)
    })
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
    await waitFor(() => {
      expect(syncNow).toHaveBeenCalled()
    })

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
    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({ token: 'tok-1' })
    })
  })

  it('lists a saved root folder that is not among the vault folders, and changes cadence', async () => {
    status.mockResolvedValue({
      ...connectedStatus,
      options: { ...READWISE_OPTIONS_DEFAULTS, rootFolder: 'Gone/Away' }
    })
    renderPanel()
    expect(await screen.findByText('/Gone/Away')).toBeInTheDocument()
  })

  describe('status banner (#1418)', () => {
    const banner = () => screen.findByTestId('readwise-status-banner')

    it('shows the last run and the next sync when idle', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastRun: {
          books: 3,
          added: 1,
          updated: 2,
          appended: 0,
          deferred: 0,
          failed: 0,
          highlights: 12
        },
        nextRunAt: new Date(Date.now() + 55 * 60_000).toISOString()
      })
      renderPanel()
      const el = await banner()
      expect(el).toHaveAttribute('data-state', 'synced')
      expect(el).toHaveTextContent('Synced 5 minutes ago')
      expect(el).toHaveTextContent('Last run: 1 added, 2 updated, 12 highlights')
      expect(el).toHaveTextContent('Next sync in 55 minutes')
    })

    it('says a run that changed nothing found nothing new', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        lastSyncAt: new Date().toISOString(),
        lastRun: {
          books: 0,
          added: 0,
          updated: 0,
          appended: 0,
          deferred: 0,
          failed: 0,
          highlights: 0
        }
      })
      renderPanel()
      expect(await banner()).toHaveTextContent('Last run: nothing new')
    })

    it('shows progress with Cancel while syncing, and Cancel stops the run', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        syncing: { stage: 'writing', planned: 12, done: 3 }
      })
      renderPanel()
      const el = await banner()
      expect(el).toHaveAttribute('data-state', 'syncing')
      expect(el).toHaveTextContent('Writing books, 3 of 12')
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => {
        expect(cancel).toHaveBeenCalled()
      })
    })

    it('says it waits for memry sync before the first pull', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        syncing: { stage: 'waiting-for-sync', planned: null, done: 0 }
      })
      renderPanel()
      const el = await banner()
      expect(el).toHaveAttribute('data-state', 'waiting-for-sync')
      expect(el).toHaveTextContent('Waiting for memry sync')
    })

    it('re-reads the status when main says it changed', async () => {
      status.mockResolvedValue(connectedStatus)
      renderPanel()
      await banner()
      status.mockResolvedValue({
        ...connectedStatus,
        syncing: { stage: 'reading', planned: null, done: 0 }
      })
      statusListeners.forEach((listener) => {
        listener()
      })
      expect(await screen.findByText('Reading your library…')).toBeInTheDocument()
    })

    it.each([
      ['rate-limited', 'Readwise is limiting requests'],
      ['network', "Can't reach Readwise"],
      ['server', 'Readwise had a problem'],
      ['subscription-expired', 'Your Readwise subscription expired']
    ] as const)('%s shows its title and Retry now, which syncs', async (kind, title) => {
      status.mockResolvedValue({
        ...connectedStatus,
        error: { kind, detail: null },
        nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString()
      })
      renderPanel()
      const el = await banner()
      expect(el).toHaveAttribute('data-state', `error:${kind}`)
      expect(el).toHaveTextContent(title)
      expect(el).toHaveAttribute('role', 'alert')
      fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
      await waitFor(() => {
        expect(syncNow).toHaveBeenCalled()
      })
    })

    it('a transient error says when the next try is, a fixable one does not', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        error: { kind: 'network', detail: null },
        nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString()
      })
      const { unmount } = renderPanel()
      expect(await banner()).toHaveTextContent('Memry tries again in 5 minutes.')
      unmount()

      status.mockResolvedValue({
        ...connectedStatus,
        error: { kind: 'subscription-expired', detail: null },
        nextRunAt: null
      })
      renderPanel()
      expect(await banner()).not.toHaveTextContent('tries again')
    })

    it('an unexpected failure shows its own text', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        error: { kind: 'unexpected', detail: 'disk gone' }
      })
      renderPanel()
      expect(await banner()).toHaveTextContent('disk gone')
    })

    it('a rejected token offers a new token, which reconnects without a disconnect', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        needsAttention: true,
        error: { kind: 'invalid-token', detail: null }
      })
      renderPanel()
      const el = await banner()
      expect(el).toHaveTextContent('Readwise needs a new token')

      fireEvent.click(screen.getByRole('button', { name: 'Paste a new token' }))
      fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'fresh' } })
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))

      await waitFor(() => {
        expect(connect).toHaveBeenCalledWith({ token: 'fresh' })
      })
      expect(disconnect).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument()
      })
    })

    it('keeps the new-token form and its error when Readwise refuses the token', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        error: { kind: 'invalid-token', detail: null }
      })
      connect.mockResolvedValue({ success: false, error: 'Readwise did not accept this token.' })
      renderPanel()
      await banner()
      fireEvent.click(screen.getByRole('button', { name: 'Paste a new token' }))
      fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'bad' } })
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      expect(await screen.findByRole('alert', { name: '' })).toBeTruthy()
      expect(await screen.findByText('Readwise did not accept this token.')).toBeInTheDocument()
    })
  })

  describe('Deleted books (D16)', () => {
    const deleted = [
      {
        readwiseBookId: 1,
        title: 'Deep Work',
        deletedAt: '2026-10-03T10:00:00Z',
        highlightCount: 41
      },
      {
        readwiseBookId: 2,
        title: 'Smart Notes',
        deletedAt: '2026-09-28T10:00:00Z',
        highlightCount: 1
      }
    ]

    it('lists each deleted book with its highlight count, and a row leaves the list once restored', async () => {
      status.mockResolvedValue(connectedStatus)
      listDeleted.mockResolvedValue({ books: deleted })
      renderPanel()

      expect(await screen.findByText('Deep Work')).toBeInTheDocument()
      expect(screen.getByText(/· 41 highlights/)).toBeInTheDocument()
      expect(screen.getByText(/· 1 highlight$/)).toBeInTheDocument()
      expect(
        screen.getByText('Restoring recreates the note with all of its highlights.')
      ).toBeInTheDocument()

      fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
      await waitFor(() => {
        expect(restoreBook).toHaveBeenCalledWith({ readwiseBookId: 1 })
      })
      await waitFor(() => {
        expect(screen.queryByText('Deep Work')).not.toBeInTheDocument()
      })
      expect(screen.getByText('Smart Notes')).toBeInTheDocument()
    })

    it('says there are none when the list is empty', async () => {
      status.mockResolvedValue(connectedStatus)
      renderPanel()
      expect(await screen.findByText('No deleted books')).toBeInTheDocument()
    })

    it('keeps the row and shows the failure when a restore is refused', async () => {
      status.mockResolvedValue(connectedStatus)
      listDeleted.mockResolvedValue({ books: deleted })
      restoreBook.mockResolvedValue({ success: false, error: 'restore refused' })
      renderPanel()

      fireEvent.click((await screen.findAllByRole('button', { name: 'Restore' }))[0])
      expect(await screen.findByText('restore refused')).toBeInTheDocument()
      expect(screen.getByText('Deep Work')).toBeInTheDocument()
    })

    it('names the pulling device and asks nothing of main on a device that does not pull', async () => {
      status.mockResolvedValue({
        ...connectedStatus,
        thisDevicePulls: false,
        pullingDeviceName: 'MacBook Pro'
      })
      renderPanel()
      expect(await screen.findByText('Syncs on MacBook Pro')).toBeInTheDocument()
      expect(listDeleted).not.toHaveBeenCalled()
    })
  })
})
