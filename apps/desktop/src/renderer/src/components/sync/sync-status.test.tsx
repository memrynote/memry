import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultBindingState } from '@memry/contracts/ipc-sync-ops'

import { Cloud } from '@/lib/icons'
import { SyncStatus } from './sync-status'

const sync = vi.hoisted(() => ({
  vaultBinding: { status: 'bound' } as VaultBindingState,
  resolveVaultBinding: vi.fn(async () => {}),
  openVaultBindingPrompt: vi.fn()
}))

const status = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }))
const auth = vi.hoisted(() => ({ resetAuthState: vi.fn() }))
const repairDeviceKeys = vi.fn()

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => auth
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSyncOptional: () => sync
}))

vi.mock('@/hooks/use-sync-status', () => ({
  useSyncStatus: () => ({
    status: 'idle',
    label: 'Synced',
    lastSyncLabel: 'now',
    dotColor: 'bg-green-500',
    IconComponent: Cloud,
    isAnimating: false,
    hasIssues: false,
    pendingCount: 0,
    localOnlyCount: 0,
    conflicts: [],
    error: null,
    sessionExpired: false,
    clockSkewDetected: false,
    initialSyncProgress: null,
    syncActivity: { pushCount: 0, pullCount: 0 },
    triggerSync: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clearError: vi.fn(),
    clearConflicts: vi.fn(),
    deviceKeysMissing: false,
    ...status.overrides
  })
}))

async function openPopover(
  onOpenSettings: () => void = vi.fn()
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(<SyncStatus onOpenSettings={onOpenSettings} iconOnly />)
  await user.click(screen.getByRole('button', { name: /Sync status/ }))
  return user
}

describe('SyncStatus vault binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    status.overrides = {}
  })

  it('offers to start syncing a vault kept on this device', async () => {
    sync.vaultBinding = { status: 'local-only' }
    const user = await openPopover()

    expect(screen.getByText('vault.binding.status.localOnly')).toBeTruthy()
    expect(screen.queryByText('Sync Now')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'vault.binding.status.startSync' }))
    expect(sync.resolveVaultBinding).toHaveBeenCalledWith('sync')
  })

  it('reopens the prompt for a vault still waiting on a decision', async () => {
    sync.vaultBinding = { status: 'needs-decision', accountVaultCount: 0, mergeTarget: null }
    const user = await openPopover()

    await user.click(screen.getByRole('button', { name: 'vault.binding.status.choose' }))
    expect(sync.openVaultBindingPrompt).toHaveBeenCalled()
  })

  it('explains another account’s vault and offers no action', async () => {
    sync.vaultBinding = { status: 'foreign' }
    await openPopover()

    expect(screen.getByText('vault.binding.status.foreign')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'vault.binding.status.startSync' })).toBeNull()
    expect(screen.queryByText('Sync Now')).toBeNull()
  })

  it('keeps the regular actions for a bound vault', async () => {
    sync.vaultBinding = { status: 'bound' }
    await openPopover()

    expect(screen.getByText('Sync Now')).toBeTruthy()
  })
})

// #2866: pushes aborted for want of device keys while the popover said Synced.
describe('SyncStatus with device keys missing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sync.vaultBinding = { status: 'bound' }
    ;(
      window as unknown as { api: { syncOps: { repairDeviceKeys: typeof repairDeviceKeys } } }
    ).api = { syncOps: { repairDeviceKeys } }
    status.overrides = {
      status: 'error',
      label: 'account.sync.statuses.deviceKeysMissing',
      hasIssues: true,
      error: 'Changes on this device are not uploading.',
      deviceKeysMissing: true
    }
  })

  it('repairs in place and keeps the session when the keys are restored', async () => {
    repairDeviceKeys.mockResolvedValue({ status: 'repaired' })
    const onOpenSettings = vi.fn()
    const user = await openPopover(onOpenSettings)

    expect(screen.getAllByText('account.sync.statuses.deviceKeysMissing').length).toBeGreaterThan(0)
    expect(screen.queryByText('Retry')).toBeNull()
    await user.click(
      screen.getByRole('button', { name: 'phaseF.componentsSyncSyncStatus.repairDeviceKeys' })
    )

    expect(repairDeviceKeys).toHaveBeenCalled()
    expect(auth.resetAuthState).not.toHaveBeenCalled()
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it('sends the user to sign in when main signed the device out', async () => {
    repairDeviceKeys.mockResolvedValue({ status: 'sign-in-required' })
    const onOpenSettings = vi.fn()
    const user = await openPopover(onOpenSettings)

    await user.click(
      screen.getByRole('button', { name: 'phaseF.componentsSyncSyncStatus.repairDeviceKeys' })
    )

    expect(auth.resetAuthState).toHaveBeenCalled()
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
