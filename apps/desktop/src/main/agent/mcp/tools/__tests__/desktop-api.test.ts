import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMcpDesktopApiChannel,
  type AgentMcpDesktopApiRequest
} from '@memry/contracts/agent-mcp-channels'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn() }
}))

vi.mock('../../../../lib/window-rpc', () => ({
  mainToRendererInvoke: vi.fn()
}))

import { BrowserWindow } from 'electron'
import { mainToRendererInvoke } from '../../../../lib/window-rpc'
import { invokeDesktopApiFromWindow } from '../desktop-api'

describe('invokeDesktopApiFromWindow', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.fromId).mockReset()
    vi.mocked(mainToRendererInvoke).mockReset()
  })

  it('requires a valid source window id', async () => {
    await expect(
      invokeDesktopApiFromWindow(null, { operation: 'templates.list', args: [] })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      invokeDesktopApiFromWindow('not-a-number', { operation: 'templates.list', args: [] })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(BrowserWindow.fromId).not.toHaveBeenCalled()
  })

  it('requires an existing memrynote window', async () => {
    vi.mocked(BrowserWindow.fromId).mockReturnValue(null)

    await expect(
      invokeDesktopApiFromWindow('123', { operation: 'templates.list', args: [] })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('forwards the request to the renderer window', async () => {
    const win = { webContents: {} } as unknown as Electron.BrowserWindow
    vi.mocked(BrowserWindow.fromId).mockReturnValue(win)
    vi.mocked(mainToRendererInvoke).mockResolvedValue({
      ok: true,
      data: { templates: [] }
    })

    await expect(
      invokeDesktopApiFromWindow('123', { operation: 'templates.list', args: [] })
    ).resolves.toEqual({ templates: [] })
    expect(mainToRendererInvoke).toHaveBeenCalledWith(
      win,
      AgentMcpDesktopApiChannel,
      { operation: 'templates.list', args: [] },
      { timeoutMs: 10_000 }
    )
  })

  it('wraps renderer-side desktop API errors', async () => {
    const win = { webContents: {} } as unknown as Electron.BrowserWindow
    vi.mocked(BrowserWindow.fromId).mockReturnValue(win)
    vi.mocked(mainToRendererInvoke).mockResolvedValue({
      ok: false,
      error: { code: 'DESKTOP_API_ERROR', message: 'Desktop API operation failed.' }
    })

    await expect(
      invokeDesktopApiFromWindow('123', { operation: 'templates.list', args: [] })
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Desktop API operation failed.',
      details: { operation: 'templates.list', code: 'DESKTOP_API_ERROR' }
    })
  })

  describe('read-only lock refusals (#2606)', () => {
    beforeEach(() => {
      vi.mocked(BrowserWindow.fromId).mockReturnValue({
        webContents: {}
      } as unknown as Electron.BrowserWindow)
    })

    it('maps a thrown lock refusal to PERMISSION_DENIED with the fixed text', async () => {
      vi.mocked(mainToRendererInvoke).mockResolvedValue({
        ok: false,
        error: { code: 'DESKTOP_API_ERROR', message: VAULT_LOCKED_NOTE_MESSAGE }
      })

      await expect(
        invokeDesktopApiFromWindow('123', { operation: 'notes.update', args: [] })
      ).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        message: VAULT_LOCKED_NOTE_MESSAGE
      })
    })

    const refusedOperations: AgentMcpDesktopApiRequest['operation'][] = [
      'notes.update',
      'notes.rename',
      'notes.delete',
      'notes.restoreVersion',
      'notes.applyTemplate',
      'notes.create',
      'notes.createFolder'
    ]

    it.each(refusedOperations)(
      'maps a %s {success:false} lock envelope to PERMISSION_DENIED',
      async (operation) => {
        vi.mocked(mainToRendererInvoke).mockResolvedValue({
          ok: true,
          data: { success: false, error: VAULT_LOCKED_NOTE_MESSAGE }
        })

        await expect(
          invokeDesktopApiFromWindow('123', { operation, args: [] })
        ).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
          message: VAULT_LOCKED_NOTE_MESSAGE,
          details: { operation }
        })
      }
    )

    it('passes any other {success:false} envelope through as data', async () => {
      const data = { success: false, error: 'Note not found: n1' }
      vi.mocked(mainToRendererInvoke).mockResolvedValue({ ok: true, data })

      await expect(
        invokeDesktopApiFromWindow('123', { operation: 'notes.update', args: [] })
      ).resolves.toEqual(data)
    })
  })
})
