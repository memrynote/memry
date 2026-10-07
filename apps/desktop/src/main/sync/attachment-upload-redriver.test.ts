import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  drain: vi.fn(async (_vaultPath: string) => {}),
  dropGone: vi.fn((_vaultPath: string) => {}),
  getToken: vi.fn<() => Promise<string | null>>(),
  vaultPath: null as string | null
}))

vi.mock('./attachment-backfill', () => ({ backfillUnsyncedAttachments: mocks.backfill }))
vi.mock('./attachment-outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachment-outbox')>()),
  drainAttachmentOutbox: mocks.drain,
  dropUploadsWithoutFile: mocks.dropGone
}))
vi.mock('./token-manager', () => ({ getValidAccessToken: mocks.getToken }))
vi.mock('../store', () => ({ getCurrentVaultPath: () => mocks.vaultPath }))

import { attachmentUploadRedriver } from './attachment-upload-redriver'

function deferredToken(): { resolve: (token: string) => void } {
  let resolve!: (token: string) => void
  mocks.getToken.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)))
  return { resolve: (token) => resolve(token) }
}

describe('attachmentUploadRedriver', () => {
  let rootDir: string
  let vaultPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getToken.mockResolvedValue('token')
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-redriver-'))
    vaultPath = path.join(rootDir, 'vault')
    fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
    mocks.vaultPath = vaultPath
  })

  afterEach(() => {
    attachmentUploadRedriver.stop()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('skips the whole pass while the vault is unreachable and runs it once it is back', async () => {
    attachmentUploadRedriver.start(() => true)
    const away = path.join(rootDir, 'vault-away')
    fs.renameSync(vaultPath, away)

    await attachmentUploadRedriver.redrive()
    expect(mocks.dropGone).not.toHaveBeenCalled()
    expect(mocks.backfill).not.toHaveBeenCalled()
    expect(mocks.drain).not.toHaveBeenCalled()

    fs.renameSync(away, vaultPath)
    await attachmentUploadRedriver.redrive()
    expect(mocks.dropGone.mock.calls).toEqual([[vaultPath]])
    expect(mocks.backfill).toHaveBeenCalledTimes(1)
    expect(mocks.drain.mock.calls).toEqual([[vaultPath]])
  })

  it('backfills and drains when online with a token', async () => {
    attachmentUploadRedriver.start(() => true)

    await attachmentUploadRedriver.redrive()

    expect(mocks.backfill).toHaveBeenCalledTimes(1)
    expect(mocks.drain).toHaveBeenCalledTimes(1)
  })

  it('does not backfill or drain when the runtime stops during the token wait', async () => {
    attachmentUploadRedriver.start(() => true)
    const token = deferredToken()
    const pass = attachmentUploadRedriver.redrive()

    attachmentUploadRedriver.stop()
    token.resolve('token')
    await pass

    expect(mocks.backfill).not.toHaveBeenCalled()
    expect(mocks.drain).not.toHaveBeenCalled()
  })

  it('does not drain the next vault from a pass started for the previous one', async () => {
    attachmentUploadRedriver.start(() => true)
    const token = deferredToken()
    const pass = attachmentUploadRedriver.redrive()

    attachmentUploadRedriver.stop()
    attachmentUploadRedriver.start(() => true)
    token.resolve('token')
    await pass

    expect(mocks.backfill).not.toHaveBeenCalled()
    expect(mocks.drain).not.toHaveBeenCalled()
  })
})
