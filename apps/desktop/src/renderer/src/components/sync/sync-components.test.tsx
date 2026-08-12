import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeviceList } from './device-list'
import { DeviceRevokedDialog } from './device-revoked-dialog'
import { LinkingApprovalDialog } from './linking-approval-dialog'
import { LinkingCodeEntry } from './linking-code-entry'
import { QrLinking } from './qr-linking'
import { SyncHistoryPanel } from './sync-history'
import { SyncStatus } from './sync-status'
import { deviceService } from '@/services/device-service'

const mocks = vi.hoisted(() => ({
  deviceService: {
    getDevices: vi.fn(),
    removeDevice: vi.fn(),
    renameDevice: vi.fn()
  },
  toast: {
    success: vi.fn(),
    error: vi.fn()
  },
  syncStatus: {
    status: 'idle',
    label: 'Synced',
    lastSyncLabel: 'just now',
    dotColor: 'bg-green-500',
    IconComponent: ({ className }: { className?: string }) => (
      <span data-testid="sync-icon" className={className} />
    ),
    isAnimating: false,
    hasIssues: false,
    pendingCount: 0,
    localOnlyCount: 0,
    conflicts: [] as unknown[],
    error: null as string | null,
    sessionExpired: false,
    clockSkewDetected: false,
    initialSyncProgress: null as null | { current: number; total: number },
    syncActivity: { pushCount: 0, pullCount: 0 },
    triggerSync: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clearError: vi.fn(),
    clearConflicts: vi.fn()
  },
  syncHistory: {
    entries: [] as any[],
    isLoading: false,
    hasMore: false,
    filter: { type: 'all', period: 'all' },
    setFilter: vi.fn(),
    loadMore: vi.fn()
  },
  countdown: {
    formattedTime: '00:30',
    isExpired: false
  },
  clipboardWrite: vi.fn(),
  selectCallbacks: [] as Array<(value: string) => void>
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`
  })
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div role="img">qr:{value}</div>
}))

vi.mock('@/services/device-service', () => ({
  deviceService: mocks.deviceService
}))

vi.mock('@/hooks/use-sync-status', () => ({
  useSyncStatus: () => mocks.syncStatus
}))

vi.mock('@/hooks/use-sync-history', () => ({
  useSyncHistory: () => mocks.syncHistory
}))

vi.mock('@/hooks/use-countdown', () => ({
  useCountdown: () => mocks.countdown
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
    'aria-label': ariaLabel
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
    'aria-label'?: string
  }) => (
    <button type={type} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    disabled
  }: {
    value: string
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
    onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
    placeholder?: string
    disabled?: boolean
  }) => (
    <input
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={onChange}
      onKeyDown={onKeyDown}
    />
  )
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open === false ? null : <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open === false ? null : <div>{children}</div>,
  AlertDialogAction: ({
    children,
    onClick,
    disabled
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    disabled
  }: {
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenuButton: ({
    children,
    onClick,
    'aria-label': ariaLabel
  }: {
    children: React.ReactNode
    onClick?: () => void
    'aria-label'?: string
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: () => <hr />
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    onValueChange
  }: {
    children: React.ReactNode
    onValueChange: (value: string) => void
  }) => {
    mocks.selectCallbacks.push(onValueChange)
    return <div>{children}</div>
  },
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button
      type="button"
      onClick={() => mocks.selectCallbacks.forEach((callback) => callback(value))}
    >
      {children}
    </button>
  ),
  SelectTrigger: ({
    children,
    'aria-label': ariaLabel
  }: {
    children: React.ReactNode
    'aria-label'?: string
  }) => (
    <button type="button" aria-label={ariaLabel}>
      {children}
    </button>
  ),
  SelectValue: () => <span />
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(true)}>
        toggle-details
      </button>
      {children}
    </div>
  ),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  )
}))

const devices = [
  {
    id: 'dev-1',
    name: 'This Mac',
    platform: 'macos',
    isCurrentDevice: true,
    linkedAt: Date.now() - 10_000
  },
  {
    id: 'dev-2',
    name: 'iPhone',
    platform: 'ios',
    isCurrentDevice: false,
    lastSyncAt: Date.now() - 20_000,
    linkedAt: Date.now() - 30_000
  },
  {
    id: 'dev-3',
    name: 'Linux Box',
    platform: 'linux',
    isCurrentDevice: false,
    linkedAt: Date.now() - 40_000
  },
  {
    id: 'dev-4',
    name: 'Tablet',
    platform: 'android',
    isCurrentDevice: false,
    linkedAt: Date.now() - 50_000
  }
]

describe('sync components coverage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.selectCallbacks.length = 0
    mocks.deviceService.getDevices.mockResolvedValue({ devices })
    mocks.deviceService.removeDevice.mockResolvedValue({ success: true })
    mocks.deviceService.renameDevice.mockResolvedValue({ success: true })
    Object.assign(mocks.syncStatus, {
      status: 'idle',
      label: 'Synced',
      lastSyncLabel: 'just now',
      dotColor: 'bg-green-500',
      isAnimating: false,
      hasIssues: false,
      pendingCount: 0,
      localOnlyCount: 0,
      conflicts: [],
      error: null,
      sessionExpired: false,
      clockSkewDetected: false,
      initialSyncProgress: null,
      syncActivity: { pushCount: 0, pullCount: 0 }
    })
    Object.assign(mocks.syncHistory, {
      entries: [],
      isLoading: false,
      hasMore: false,
      filter: { type: 'all', period: 'all' }
    })
    mocks.countdown.formattedTime = '00:30'
    mocks.countdown.isExpired = false
    mocks.clipboardWrite.mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.clipboardWrite }
    })
    ;(window as any).api = {
      ...(window as any).api,
      syncLinking: {
        generateLinkingQr: vi.fn().mockResolvedValue({
          qrData: JSON.stringify({ sessionId: 'session-1', ephemeralPublicKey: 'pub' }),
          sessionId: 'session-1',
          expiresAt: Date.now() + 30_000
        }),
        linkViaQr: vi.fn().mockResolvedValue({
          success: true,
          verificationCode: '654321'
        }),
        getLinkingSas: vi.fn().mockResolvedValue({ verificationCode: '123456' }),
        approveLinking: vi.fn().mockResolvedValue({ success: true })
      }
    }
  })

  it('loads devices, expands hidden rows, renames, revokes, and starts linking', async () => {
    const onLinkDevice = vi.fn()
    render(<DeviceList onLinkDevice={onLinkDevice} />)

    expect(screen.getByRole('status', { name: 'devices.loadingAria' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('This Mac')).toBeInTheDocument())
    expect(screen.queryByText('Tablet')).not.toBeInTheDocument()

    expect(
      screen.getByText(
        `devices.platformMeta${JSON.stringify({
          platform: 'macOS',
          detail: `devices.linked${JSON.stringify({ time: 'less than a minute' })}`
        })}`
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /devices.showMoreAria/ }))
    expect(screen.getByText('Tablet')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'devices.rename' })[0])
    fireEvent.change(screen.getByDisplayValue('iPhone'), { target: { value: 'Pocket Phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'button.save' }))
    await waitFor(() =>
      expect(deviceService.renameDevice).toHaveBeenCalledWith({
        deviceId: 'dev-2',
        newName: 'Pocket Phone'
      })
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'devices.revoke' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'devices.dialogs.revokeDevice' }))
    await waitFor(() =>
      expect(deviceService.removeDevice).toHaveBeenCalledWith({ deviceId: 'dev-2' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'devices.linkNew' }))
    expect(onLinkDevice).toHaveBeenCalledTimes(1)
  })

  it('shows empty and failed device-list states', async () => {
    const onLinkDevice = vi.fn()
    mocks.deviceService.getDevices.mockResolvedValueOnce({ devices: [] })
    const { unmount } = render(<DeviceList onLinkDevice={onLinkDevice} />)

    await waitFor(() => expect(screen.getByText('devices.none')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'devices.linkNew' }))
    expect(onLinkDevice).toHaveBeenCalledTimes(1)
    unmount()

    mocks.deviceService.getDevices.mockRejectedValueOnce(new Error('load failed'))
    render(<DeviceList />)
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('devices.toasts.loadFailed'))
  })

  it('runs sync status actions for issue and paused states', async () => {
    mocks.syncStatus.status = 'idle'
    mocks.syncStatus.hasIssues = true
    mocks.syncStatus.pendingCount = 2
    mocks.syncStatus.localOnlyCount = 1
    mocks.syncStatus.conflicts = [{ id: 'conflict-1' }]
    mocks.syncStatus.clockSkewDetected = true
    mocks.syncStatus.error = 'network down'
    const openSettings = vi.fn()

    const { rerender } = render(<SyncStatus onOpenSettings={openSettings} />)

    expect(
      screen.getByText('2 changes phaseF.componentsSyncSyncStatus.pending')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.syncStatus.triggerSync).toHaveBeenCalledTimes(1))
    expect(mocks.syncStatus.clearError).toHaveBeenCalledTimes(1)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsSyncSyncStatus.openSyncSettings'
      })
    )
    expect(openSettings).toHaveBeenCalledTimes(1)

    mocks.syncStatus.status = 'paused'
    mocks.syncStatus.error = null
    rerender(<SyncStatus onOpenSettings={openSettings} iconOnly />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(mocks.syncStatus.resume).toHaveBeenCalledTimes(1))
  })

  it('renders sync history, opens error details, filters, and loads more', () => {
    mocks.syncHistory.entries = [
      {
        id: 'hist-1',
        type: 'push',
        itemCount: 1,
        durationMs: 500,
        createdAt: Date.now() - 1000
      },
      {
        id: 'hist-2',
        type: 'error',
        itemCount: 0,
        details: { error: 'token expired' },
        createdAt: Date.now() - 2000
      }
    ]
    mocks.syncHistory.hasMore = true

    render(<SyncHistoryPanel />)

    expect(
      screen.getByText(
        `phaseF.componentsSyncSyncHistory.summaryPushed${JSON.stringify({ count: 1 })}`
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        `phaseF.componentsSyncSyncHistory.duration${JSON.stringify({ duration: '500ms' })}`
      )
    ).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsSyncSyncHistory.summaryFailed')).toBeInTheDocument()
    expect(screen.getByText('token expired')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsSyncSyncHistory.pushed' }))
    expect(mocks.syncHistory.setFilter).toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsSyncSyncHistory.loadMore' })
    )
    expect(mocks.syncHistory.loadMore).toHaveBeenCalledTimes(1)
  })

  it('handles revoked-device export and sign-out decisions', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    const onSignOut = vi.fn()

    render(<DeviceRevokedDialog open unsyncedCount={2} onExport={onExport} onSignOut={onSignOut} />)

    expect(screen.getByText(/2 items haven't been synced yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Export Local Data' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exported' })).toBeDisabled())
    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsSyncDeviceRevokedDialog.signOut'
      })
    )
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('generates QR linking sessions, copies codes, and cancels', async () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    render(<QrLinking onCancel={onCancel} />)

    expect(screen.getByRole('status', { name: 'qrLinking.generatingAria' })).toBeInTheDocument()
    act(() => vi.runOnlyPendingTimers())
    await waitFor(() => expect(screen.getByRole('img')).toHaveTextContent('qr:'))

    fireEvent.click(screen.getByRole('button', { name: 'qrLinking.copyAria' }))
    await waitFor(() =>
      expect(mocks.clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('session-1'))
    )

    fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('links devices from pasted QR data and reports failures', async () => {
    const onLinked = vi.fn()
    const onError = vi.fn()
    const onBack = vi.fn()
    const validCode = JSON.stringify({ sessionId: 'session-2', ephemeralPublicKey: 'pub-2' })

    render(<LinkingCodeEntry onLinked={onLinked} onError={onError} onBack={onBack} />)

    fireEvent.change(screen.getByLabelText('setup.linking.codeLabel'), {
      target: { value: 'not-json' }
    })
    expect(screen.getByText('setup.linking.formatHint')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('setup.linking.codeLabel'), {
      target: { value: validCode }
    })
    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.linkDevice' }))
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith('session-2', '654321'))
    ;(window as any).api.syncLinking.linkViaQr.mockResolvedValueOnce({
      success: false,
      error: 'expired'
    })
    fireEvent.change(screen.getByLabelText('setup.linking.codeLabel'), {
      target: { value: validCode.replace('session-2', 'session-3') }
    })
    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.linkDevice' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('expired'))

    fireEvent.click(screen.getByRole('button', { name: 'button.back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows linking approval SAS codes, approves, rejects, and surfaces errors', async () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const event = {
      sessionId: 'session-4',
      newDeviceName: 'New Mac',
      newDevicePlatform: 'desktop'
    } as any

    const { rerender } = render(
      <LinkingApprovalDialog open event={event} onApprove={onApprove} onReject={onReject} />
    )

    await waitFor(() => expect(screen.getByText('123 456')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'linkingApproval.approve' }))
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('session-4'))
    ;(window as any).api.syncLinking.approveLinking.mockResolvedValueOnce({
      success: false,
      error: 'approval failed'
    })
    rerender(
      <LinkingApprovalDialog
        open
        event={{ ...event, sessionId: 'session-5' }}
        onApprove={onApprove}
        onReject={onReject}
      />
    )
    await waitFor(() => expect(screen.getByText('123 456')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'linkingApproval.approve' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('approval failed'))

    fireEvent.click(screen.getByRole('button', { name: 'linkingApproval.reject' }))
    expect(onReject).toHaveBeenCalledTimes(1)
  })
})
