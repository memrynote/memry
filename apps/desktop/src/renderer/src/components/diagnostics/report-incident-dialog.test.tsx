import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { DiagnosticReport, DiagnosticTrigger } from '@memry/contracts/diagnostics-api'
import { ReportIncidentDialog } from './report-incident-dialog'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

const trigger: DiagnosticTrigger = {
  source: 'editor-error-boundary',
  errorCode: 'RENDER_FAIL'
}

const fixedReport: DiagnosticReport = {
  schemaVersion: 1,
  installId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  appVersion: '1.2.3',
  buildChannel: 'production',
  platform: 'darwin',
  arch: 'arm64',
  incidentId: 'MEMRY-ABCD1234',
  trigger: { source: 'editor-error-boundary', errorCode: 'RENDER_FAIL' },
  snapshot: {
    appVersion: '1.2.3',
    buildChannel: 'production',
    platform: 'darwin',
    arch: 'arm64',
    locale: 'en',
    uptimeSeconds: 120,
    syncEnabled: true,
    syncState: 'enabled',
    queueDepth: 0,
    vaultOpen: true,
    authState: 'signed_in'
  },
  lines: [
    {
      ts: '2026-07-18T10:00:00.000Z',
      level: 'error',
      scope: 'SyncWorker',
      message: 'Redacted failure: connection reset [REDACTED_PATH]',
      origin: 'main'
    }
  ]
}

function mockDiagnosticsApi(overrides?: {
  previewReport?: () => Promise<unknown>
  sendReport?: () => Promise<unknown>
}) {
  const previewReport =
    overrides?.previewReport ?? vi.fn().mockResolvedValue({ success: true, report: fixedReport })
  const sendReport =
    overrides?.sendReport ??
    vi.fn().mockResolvedValue({ success: true, incidentId: 'MEMRY-ABCD2345' })

  ;(window as unknown as { api: Record<string, unknown> }).api = {
    ...(window as unknown as { api: Record<string, unknown> }).api,
    diagnostics: { previewReport, sendReport }
  }

  return { previewReport, sendReport }
}

async function openPreview() {
  const trigger = await screen.findByRole('button', { name: /preview/i })
  await userEvent.click(trigger)
}

describe('ReportIncidentDialog', () => {
  beforeEach(() => {
    mockDiagnosticsApi()
  })

  it('shows the consent copy and the redacted preview once building finishes', async () => {
    mockDiagnosticsApi()
    render(<ReportIncidentDialog open trigger={trigger} onOpenChange={() => {}} />)

    expect(await screen.findByText(/redacted technical logs only/i)).toBeInTheDocument()

    await openPreview()

    expect(
      await screen.findByText('Redacted failure: connection reset [REDACTED_PATH]')
    ).toBeInTheDocument()
  })

  it('sends the exact previewed report on Send and shows the incident code', async () => {
    const { previewReport, sendReport } = mockDiagnosticsApi()
    render(<ReportIncidentDialog open trigger={trigger} onOpenChange={() => {}} />)

    await waitFor(() => expect(previewReport).toHaveBeenCalledWith(trigger))

    const sendButton = await screen.findByRole('button', { name: /^send$/i })
    await userEvent.click(sendButton)

    await waitFor(() => expect(sendReport).toHaveBeenCalledWith(fixedReport))
    expect(await screen.findByText(/MEMRY-ABCD2345/)).toBeInTheDocument()
  })

  it('closes without sending when Not now is clicked', async () => {
    const { sendReport } = mockDiagnosticsApi()
    const onOpenChange = vi.fn()
    render(<ReportIncidentDialog open trigger={trigger} onOpenChange={onOpenChange} />)

    const notNowButton = await screen.findByRole('button', { name: /not now/i })
    await userEvent.click(notNowButton)

    expect(sendReport).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the error message when previewReport fails', async () => {
    mockDiagnosticsApi({
      previewReport: vi.fn().mockResolvedValue({ success: false, error: 'redaction failed' })
    })
    render(<ReportIncidentDialog open trigger={trigger} onOpenChange={() => {}} />)

    expect(await screen.findByText('redaction failed')).toBeInTheDocument()
  })

  it('ignores a stale sendReport resolution after the cycle is superseded', async () => {
    vi.mocked(toast.success).mockClear()
    let resolveSend: (value: { success: true; incidentId: string }) => void = () => {}
    const sendReport = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve
        })
    )
    const previewReport = vi.fn().mockResolvedValue({ success: true, report: fixedReport })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api: Record<string, unknown> }).api,
      diagnostics: { previewReport, sendReport }
    }

    const triggerA: DiagnosticTrigger = { source: 'cycle-a' }
    const triggerB: DiagnosticTrigger = { source: 'cycle-b' }

    const { rerender } = render(
      <ReportIncidentDialog open trigger={triggerA} onOpenChange={() => {}} />
    )

    // Cycle A reaches preview; start an in-flight send.
    const sendButton = await screen.findByRole('button', { name: /^send$/i })
    await userEvent.click(sendButton)
    await waitFor(() => expect(sendReport).toHaveBeenCalledTimes(1))

    // Supersede: reopen with a NEW trigger (dialog stays mounted). Cycle B
    // re-previews and returns to the preview state.
    rerender(<ReportIncidentDialog open trigger={triggerB} onOpenChange={() => {}} />)
    await waitFor(() => expect(previewReport).toHaveBeenCalledTimes(2))
    await screen.findByRole('button', { name: /^send$/i })

    // The STALE send for cycle A now resolves — it must not clobber cycle B.
    await act(async () => {
      resolveSend({ success: true, incidentId: 'MEMRY-STALE0' })
    })

    expect(screen.queryByText(/MEMRY-STALE0/)).toBeNull()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
