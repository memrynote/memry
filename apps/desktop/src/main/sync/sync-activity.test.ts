import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

import { closeActivityLog, listActivity, openActivityLog } from '../vault/activity-log'
import {
  recordAttachmentDownloadFailure,
  recordAttachmentUploadFailure,
  recordSyncStatusActivity
} from './sync-activity'

describe('sync activity', () => {
  let vaultPath: string

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sync-activity-'))
    openActivityLog(vaultPath)
  })

  afterEach(async () => {
    await closeActivityLog()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('records a note over the sync cap once, by title', () => {
    const event = {
      status: 'error',
      pendingCount: 0,
      errorCategory: 'note_too_large',
      errorNoteTitle: 'Server log dump'
    }
    recordSyncStatusActivity(event)
    recordSyncStatusActivity(event)

    expect(listActivity()).toEqual([
      expect.objectContaining({
        kind: 'failed',
        source: 'sync',
        reason: 'note-too-large',
        message: 'Server log dump'
      })
    ])
  })

  it('records an unnamed too-large note without a message', () => {
    recordSyncStatusActivity({ status: 'error', pendingCount: 0, errorCategory: 'note_too_large' })
    expect(listActivity()[0]).not.toHaveProperty('message')
  })

  it('ignores every other status event', () => {
    recordSyncStatusActivity(null)
    recordSyncStatusActivity('error')
    recordSyncStatusActivity({ status: 'error', errorCategory: 'storage_quota_exceeded' })
    recordSyncStatusActivity({ status: 'idle', pendingCount: 0 })
    expect(listActivity()).toEqual([])
  })

  it('tells a file over the plan limit apart from other upload failures', () => {
    const big = path.join(vaultPath, 'notes', 'video.mp4')
    const other = path.join(vaultPath, 'notes', 'scan.pdf')
    recordAttachmentUploadFailure(big, 'file_too_large', '413')
    recordAttachmentUploadFailure(big, 'file_too_large', '413')
    recordAttachmentUploadFailure(other, 'network', 'socket hang up')

    expect(listActivity().map((entry) => [entry.path, entry.reason, entry.message])).toEqual([
      ['notes/scan.pdf', 'attachment-upload-failed', 'socket hang up'],
      ['notes/video.mp4', 'file-too-large', '413']
    ])
  })

  it('records a download failure once per file', () => {
    const file = path.join(vaultPath, 'attachments', 'photo.png')
    recordAttachmentDownloadFailure(file, 'not found')
    recordAttachmentDownloadFailure(file, 'not found')

    expect(listActivity()).toEqual([
      expect.objectContaining({
        path: 'attachments/photo.png',
        reason: 'attachment-download-failed',
        message: 'not found'
      })
    ])
  })
})
