/**
 * Custom icon IPC handlers — the link path.
 *
 * @module ipc/custom-icon-handlers.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const downloadRemoteIcon = vi.fn()
const writeCustomIconFile = vi.fn(
  async (_id: string, _ext: string, _data: Buffer) => '/vault/.memry/icons/id.png'
)
const insertCustomIcon = vi.fn((_db, input: Record<string, unknown>) => ({
  ...input,
  createdAt: '2026-08-21T00:00:00.000Z'
}))
const enqueueCustomIconCreate = vi.fn()
const broadcastToAllWindows = vi.fn()
const listCustomIcons = vi.fn(() => [] as Record<string, unknown>[])
const customIconFileExists = vi.fn(async () => true)
const logWarn = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => bytes.length === 0,
      getSize: () => ({ width: 64, height: 64 }),
      resize: vi.fn(),
      toPNG: () => Buffer.concat([Buffer.from('png:'), bytes])
    })
  }
}))
vi.mock('nanoid', () => ({ nanoid: () => 'icon-1' }))
vi.mock('../icons/remote-icon', () => ({ downloadRemoteIcon }))
vi.mock('../icons/store', () => ({
  insertCustomIcon,
  listCustomIcons,
  getCustomIcon: vi.fn(),
  deleteCustomIcon: vi.fn(),
  renameCustomIcon: vi.fn()
}))
vi.mock('../icons/runtime-effects', () => ({
  enqueueCustomIconCreate,
  enqueueCustomIconUpdate: vi.fn(),
  enqueueCustomIconDelete: vi.fn()
}))
vi.mock('../vault/custom-icons', () => ({
  writeCustomIconFile,
  deleteCustomIconFile: vi.fn(),
  customIconFileExists,
  getCustomIconFilePath: (id: string, ext: string) => `/vault/.memry/icons/${id}.${ext}`
}))
vi.mock('../database', () => ({ requireDatabase: vi.fn() }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../lib/main-i18n', () => ({ getMainI18n: () => ({ t: (key: string) => key }) }))

const { makeCustomIconHandlers } = await import('./custom-icon-handlers')

const db = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  listCustomIcons.mockReturnValue([])
  customIconFileExists.mockResolvedValue(true)
})

describe('addFromUrl', () => {
  it('stores the downloaded bytes locally, not the link', async () => {
    downloadRemoteIcon.mockResolvedValue({
      bytes: Buffer.from('remote'),
      ext: 'png',
      name: 'star'
    })

    const icon = await makeCustomIconHandlers(db).addFromUrl({
      url: 'https://example.com/star.png'
    })

    expect(downloadRemoteIcon).toHaveBeenCalledWith('https://example.com/star.png')
    expect(writeCustomIconFile).toHaveBeenCalledWith('icon-1', 'png', Buffer.from('png:remote'))
    expect(insertCustomIcon).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: 'star', ext: 'png' })
    )
    // The row carries bytes, so a second device rebuilds the file from the record.
    expect(insertCustomIcon.mock.calls[0][1].data).toBe(
      Buffer.from('png:remote').toString('base64')
    )
    expect(icon.path).toBe('/vault/.memry/icons/icon-1.png')
    expect(enqueueCustomIconCreate).toHaveBeenCalledWith('icon-1')
    expect(broadcastToAllWindows).toHaveBeenCalled()
  })

  it('prefers a caller-supplied name over the one in the link', async () => {
    downloadRemoteIcon.mockResolvedValue({
      bytes: Buffer.from('remote'),
      ext: 'png',
      name: 'star'
    })

    await makeCustomIconHandlers(db).addFromUrl({
      url: 'https://example.com/star.png',
      name: 'Client logo'
    })

    expect(insertCustomIcon).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: 'Client logo' })
    )
  })

  it('never reaches the network for a malformed request', async () => {
    await expect(makeCustomIconHandlers(db).addFromUrl({})).rejects.toThrow()
    expect(downloadRemoteIcon).not.toHaveBeenCalled()
    expect(writeCustomIconFile).not.toHaveBeenCalled()
  })

  it('rejects a download that came back over the size ceiling', async () => {
    downloadRemoteIcon.mockResolvedValue({
      bytes: Buffer.alloc(3 * 1024 * 1024),
      ext: 'png',
      name: 'huge'
    })

    await expect(
      makeCustomIconHandlers(db).addFromUrl({ url: 'https://example.com/huge.png' })
    ).rejects.toThrow('errors:customIcon.tooLarge')
    expect(insertCustomIcon).not.toHaveBeenCalled()
  })

  it('stores a downloaded SVG sanitized, not verbatim', async () => {
    downloadRemoteIcon.mockResolvedValue({
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(1)">' +
          '<script>alert(1)</script><image href="https://evil.test/x.png"/>' +
          '<path d="M0 0h8v8H0z"/></svg>'
      ),
      ext: 'svg',
      name: 'logo'
    })

    await makeCustomIconHandlers(db).addFromUrl({ url: 'https://example.com/logo.svg' })

    const written = writeCustomIconFile.mock.calls[0][2]
    const markup = written.toString('utf8')
    expect(markup).not.toMatch(/script|onload|evil\.test/i)
    expect(markup).toContain('<path d="M0 0h8v8H0z"/>')
    // The synced row carries the sanitized bytes too, so peers never see the
    // original markup.
    expect(insertCustomIcon.mock.calls[0][1].data).toBe(written.toString('base64'))
  })

  it('rejects a download whose SVG sanitizes down to nothing', async () => {
    downloadRemoteIcon.mockResolvedValue({
      bytes: Buffer.from('<script>alert(1)</script>'),
      ext: 'svg',
      name: 'evil'
    })

    await expect(
      makeCustomIconHandlers(db).addFromUrl({ url: 'https://example.com/evil.svg' })
    ).rejects.toThrow('errors:customIcon.unreadableImage')
    expect(writeCustomIconFile).not.toHaveBeenCalled()
    expect(insertCustomIcon).not.toHaveBeenCalled()
  })
})

describe('list', () => {
  const row = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'a',
    name: 'A',
    ext: 'png',
    data: Buffer.from('bytes').toString('base64'),
    createdAt: '2026-08-21T00:00:00.000Z',
    ...over
  })

  it('skips a row whose extension is not one we store', async () => {
    listCustomIcons.mockReturnValue([row({ id: 'ok' }), row({ id: 'weird', ext: 'html' })])

    const icons = await makeCustomIconHandlers(db).list()

    expect(icons.map((icon) => icon.id)).toEqual(['ok'])
    expect(logWarn).toHaveBeenCalledWith(
      'Skipping custom icon with unsupported extension',
      expect.objectContaining({ id: 'weird', ext: 'html' })
    )
  })

  it('logs and keeps going when a legacy row cannot be rehydrated', async () => {
    listCustomIcons.mockReturnValue([row({ id: 'broken', ext: 'svg' }), row({ id: 'ok' })])
    customIconFileExists.mockResolvedValue(false)
    writeCustomIconFile.mockRejectedValueOnce(new Error('Custom icon broken is not a usable SVG'))

    const icons = await makeCustomIconHandlers(db).list()

    // The row stays listed and intact; only the file write failed.
    expect(icons.map((icon) => icon.id)).toEqual(['broken', 'ok'])
    expect(logWarn).toHaveBeenCalledWith(
      'Failed to rehydrate custom icon file',
      expect.objectContaining({ id: 'broken' })
    )
  })
})
