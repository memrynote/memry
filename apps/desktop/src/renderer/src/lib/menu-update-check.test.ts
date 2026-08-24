import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

const { toast } = vi.hoisted(() => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('sonner', () => ({ toast }))
vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import { runMenuUpdateCheck } from './menu-update-check'

const baseState: AppUpdateState = {
  currentVersion: '1.0.0',
  status: 'up-to-date',
  updateSupported: true,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  releaseNotesHtml: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoCheckEnabled: true
}

let checkForUpdates: ReturnType<typeof vi.fn>

function mockUpdaterResult(result: Partial<AppUpdateState>): void {
  checkForUpdates.mockResolvedValue({ ...baseState, ...result })
}

describe('runMenuUpdateCheck', () => {
  beforeEach(() => {
    toast.info.mockClear()
    toast.success.mockClear()
    toast.error.mockClear()
    checkForUpdates = vi.fn()
    ;(window.api.updater as Record<string, unknown>).checkForUpdates = checkForUpdates
  })

  it('confirms an up-to-date install', async () => {
    mockUpdaterResult({ status: 'up-to-date' })

    await runMenuUpdateCheck()

    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('general.updates.upToDateToast')
  })

  it('says so in dev builds, where updates are unsupported', async () => {
    mockUpdaterResult({ status: 'unavailable', updateSupported: false })

    await runMenuUpdateCheck()

    expect(toast.info).toHaveBeenCalledWith('general.updates.unsupportedToast')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reports an available update even when the in-app prompt stays silent', async () => {
    // Auto-download suppresses UpdatePromptDialog, so the toast is the only
    // feedback an explicit menu click gets.
    mockUpdaterResult({ status: 'available', availableVersion: '1.1.0' })

    await runMenuUpdateCheck()

    expect(toast.info).toHaveBeenCalledWith('general.updates.available')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('surfaces the updater error from state', async () => {
    mockUpdaterResult({ status: 'error', error: 'feed unreachable' })

    await runMenuUpdateCheck()

    expect(toast.error).toHaveBeenCalledWith('feed unreachable')
  })

  it('surfaces a failed IPC call', async () => {
    checkForUpdates.mockRejectedValue(new Error('ipc exploded'))

    await runMenuUpdateCheck()

    expect(toast.error).toHaveBeenCalledWith('ipc exploded')
  })
})
