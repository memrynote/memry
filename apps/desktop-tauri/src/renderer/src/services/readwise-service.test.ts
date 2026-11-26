import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    importReadwiseStatus: vi.fn(),
    importReadwiseConnect: vi.fn(),
    importReadwiseDisconnect: vi.fn(),
    importReadwiseSyncNow: vi.fn(),
    importReadwiseSetOptions: vi.fn(),
    importReadwiseCancel: vi.fn(),
    importReadwiseAckErrorToast: vi.fn()
  },
  listen: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({
  commands: mocks.commands,
  events: { importReadwiseStatusChangedEvent: { listen: mocks.listen } }
}))

import { onReadwiseStatusChanged, readwiseService } from './readwise-service'

describe('readwise-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers the status and a connect as the status itself', async () => {
    const status = { connected: true, hasImported: false }
    mocks.commands.importReadwiseStatus.mockResolvedValue(status)
    mocks.commands.importReadwiseConnect.mockResolvedValue(status)

    await expect(readwiseService.status()).resolves.toBe(status)
    await expect(readwiseService.connect({ token: 'pasted' })).resolves.toBe(status)
    expect(mocks.commands.importReadwiseConnect).toHaveBeenCalledWith('pasted')
  })

  it("answers a failure in Electron's envelope with the command's sentence", async () => {
    mocks.commands.importReadwiseSyncNow.mockRejectedValue({
      kind: 'internal',
      code: 'readwise_sync_failed',
      message: 'Readwise syncs on Laptop.'
    })
    mocks.commands.importReadwiseDisconnect.mockResolvedValue(null)

    await expect(readwiseService.syncNow()).resolves.toEqual({
      success: false,
      error: 'Readwise syncs on Laptop.'
    })
    await expect(readwiseService.disconnect()).resolves.toEqual({ success: true })
  })

  it('sends only the options given, the rest as unset', async () => {
    mocks.commands.importReadwiseSetOptions.mockResolvedValue({ connected: true })

    await readwiseService.setOptions({ cadence: 'manual', categories: { tweets: false } })

    expect(mocks.commands.importReadwiseSetOptions).toHaveBeenCalledWith({
      rootFolder: null,
      folderLayout: null,
      categories: {
        books: null,
        articles: null,
        tweets: false,
        podcasts: null,
        supplementals: null
      },
      cadence: 'manual',
      readerDocuments: null,
      readerFullText: null,
      journalHighlights: null
    })
  })

  it('answers the error toast claim as { first }', async () => {
    mocks.commands.importReadwiseAckErrorToast.mockResolvedValue(true)
    await expect(readwiseService.ackErrorToast()).resolves.toEqual({ first: true })
  })

  it('calls back on each status change until unsubscribed', async () => {
    let deliver: (event: { payload: null }) => void = () => undefined
    const unlisten = vi.fn()
    mocks.listen.mockImplementation((handler: typeof deliver) => {
      deliver = handler
      return Promise.resolve(unlisten)
    })
    const callback = vi.fn()

    const stop = onReadwiseStatusChanged(callback)
    deliver({ payload: null })
    expect(callback).toHaveBeenCalledTimes(1)
    stop()
    deliver({ payload: null })
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
