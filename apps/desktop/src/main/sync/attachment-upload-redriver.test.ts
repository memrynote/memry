import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  drain: vi.fn(async () => {}),
  dropGone: vi.fn(),
  getToken: vi.fn<() => Promise<string | null>>()
}))

vi.mock('./attachment-backfill', () => ({ backfillUnsyncedAttachments: mocks.backfill }))
vi.mock('./attachment-outbox', () => ({
  drainAttachmentOutbox: mocks.drain,
  dropUploadsWithoutFile: mocks.dropGone
}))
vi.mock('./token-manager', () => ({ getValidAccessToken: mocks.getToken }))

import { attachmentUploadRedriver } from './attachment-upload-redriver'

function deferredToken(): { resolve: (token: string) => void } {
  let resolve!: (token: string) => void
  mocks.getToken.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)))
  return { resolve: (token) => resolve(token) }
}

describe('attachmentUploadRedriver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getToken.mockResolvedValue('token')
  })

  afterEach(() => {
    attachmentUploadRedriver.stop()
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
