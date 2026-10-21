import { describe, expect, it } from 'vitest'
import { APP_USER_MODEL_ID, appUserModelIdOverride } from './windows-install-layout'

const velopackExec = 'C:\\Users\\k\\AppData\\Local\\MemryNote\\current\\Memrynote.exe'
const nsisExec = 'C:\\Program Files\\MemryNote\\Memrynote.exe'

describe('appUserModelIdOverride', () => {
  it('keeps the Velopack-assigned ID so the pinned shortcut and window share one taskbar icon', () => {
    const exists = (p: string) => p === 'C:\\Users\\k\\AppData\\Local\\MemryNote\\Update.exe'
    expect(appUserModelIdOverride(velopackExec, exists)).toBeNull()
  })

  it('sets the electron-builder appId on NSIS installs', () => {
    const exists = (p: string) => p === 'C:\\Program Files\\MemryNote\\Uninstall MemryNote.exe'
    expect(appUserModelIdOverride(nsisExec, exists)).toBe(APP_USER_MODEL_ID)
  })

  it('sets it for dev and unknown layouts', () => {
    expect(appUserModelIdOverride('/dev/electron', () => false)).toBe(APP_USER_MODEL_ID)
  })
})
