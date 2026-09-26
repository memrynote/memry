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
    clearConflicts: vi.fn()
  })
}))

async function openPopover(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(<SyncStatus onOpenSettings={vi.fn()} iconOnly />)
  await user.click(screen.getByRole('button', { name: /Sync status/ }))
  return user
}

describe('SyncStatus vault binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
