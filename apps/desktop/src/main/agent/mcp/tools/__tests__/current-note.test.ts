import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn() }
}))

vi.mock('../../../../lib/window-rpc', () => ({
  mainToRendererInvoke: vi.fn()
}))

import { BrowserWindow } from 'electron'
import { mainToRendererInvoke } from '../../../../lib/window-rpc'
import { snapshotCurrentNoteFromWindow } from '../current-note'

describe('snapshotCurrentNoteFromWindow', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.fromId).mockReset()
    vi.mocked(mainToRendererInvoke).mockReset()
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
    vi.mocked(mainToRendererInvoke).mockResolvedValue({
      id: 'n1',
      title: 'Today',
      content_markdown: '# Today',
      tags: ['daily']
    })
    const win = {
      webContents: {}
    } as unknown as Electron.BrowserWindow
    vi.mocked(BrowserWindow.fromId).mockReturnValue(win)

    await expect(snapshotCurrentNoteFromWindow('99')).resolves.toEqual({
      id: 'n1',
      title: 'Today',
      content_markdown: '# Today',
      tags: ['daily']
    })
    expect(mainToRendererInvoke).toHaveBeenCalledWith(win, 'agent_mcp:get_current_note', undefined)
  })
})
