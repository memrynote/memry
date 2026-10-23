import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppMenuCommandEvent } from '@memry/contracts/ipc-channels'
import { AppCommandOwners } from '.'
import { resetCommandStoreForTests } from './store'

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  updateSettings: vi.fn(),
  toastError: vi.fn(),
  windowClose: vi.fn(),
  checkForUpdates: vi.fn()
}))

vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.logger }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, info: vi.fn() } }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ updateSettings: mocks.updateSettings })
}))
vi.mock('@/lib/menu-update-check', () => ({ runMenuUpdateCheck: mocks.checkForUpdates }))

let send: (payload: { command: string }) => void = () => {}

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
  mocks.updateSettings.mockResolvedValue(true)
  Object.assign(window, {
    api: {
      onMenuCommand: (callback: (event: AppMenuCommandEvent) => void) => {
        // Main and the renderer ship together, so only a test sends an id the type forbids.
        send = (payload) => callback(payload as AppMenuCommandEvent)
        return () => {}
      },
      windowClose: mocks.windowClose
    }
  })
})

describe('native menu bridge', () => {
  it('runs the owner of the command a menu item names', async () => {
    render(<AppCommandOwners />)

    await act(async () => send({ command: 'app.closeWindow' }))
    expect(mocks.windowClose).toHaveBeenCalledTimes(1)

    await act(async () => send({ command: 'app.checkForUpdates' }))
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['view.themeLight', 'light'],
    ['view.themeDark', 'dark'],
    ['view.themeWhite', 'white'],
    ['view.themeSystem', 'system']
  ])('View → Theme: %s switches to %s', async (command, theme) => {
    render(<AppCommandOwners />)

    await act(async () => send({ command }))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme })
  })

  it('tells the user when the theme could not be saved', async () => {
    mocks.updateSettings.mockResolvedValue(false)
    render(<AppCommandOwners />)

    await act(async () => send({ command: 'view.themeDark' }))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('logs an id this build does not know and runs nothing', async () => {
    render(<AppCommandOwners />)

    await act(async () => send({ command: 'file.closeTab' }))

    expect(mocks.logger.warn).toHaveBeenCalledWith('Ignored unknown menu command', {
      command: 'file.closeTab'
    })
    expect(mocks.windowClose).not.toHaveBeenCalled()
  })

  it('drops a command nothing owns right now', async () => {
    render(<AppCommandOwners />)

    // `note.find` needs a note tab; with none mounted it is a no-op, as before.
    await act(async () => send({ command: 'note.find' }))
    expect(mocks.logger.warn).not.toHaveBeenCalled()
  })
})
