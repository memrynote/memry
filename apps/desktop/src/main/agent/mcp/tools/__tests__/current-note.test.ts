import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn() }
}))

import { BrowserWindow } from 'electron'
import { snapshotCurrentNoteFromWindow } from '../current-note'

describe('snapshotCurrentNoteFromWindow', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.fromId).mockReset()
  })

  it('returns null when window id is invalid', async () => {
    vi.mocked(BrowserWindow.fromId).mockReturnValue(null)

    await expect(snapshotCurrentNoteFromWindow('123')).resolves.toBeNull()
  })

  it('returns null when window id is non-numeric', async () => {
    await expect(snapshotCurrentNoteFromWindow('not-a-number')).resolves.toBeNull()
    expect(BrowserWindow.fromId).not.toHaveBeenCalled()
  })

  it('asks the renderer and returns the snapshot', async () => {
    const invoke = vi.fn(async () => ({
      id: 'n1',
      title: 'Today',
      content_markdown: '# Today',
      tags: ['daily']
    }))
    vi.mocked(BrowserWindow.fromId).mockReturnValue({
      webContents: { invoke }
    } as unknown as Electron.BrowserWindow)

    await expect(snapshotCurrentNoteFromWindow('99')).resolves.toEqual({
      id: 'n1',
      title: 'Today',
      content_markdown: '# Today',
      tags: ['daily']
    })
    expect(invoke).toHaveBeenCalledWith('agent_mcp:get_current_note', undefined)
  })
})
