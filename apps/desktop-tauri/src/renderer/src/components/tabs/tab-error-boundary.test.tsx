import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openReport = vi.fn()
const previewReport = vi.fn()
const sendReport = vi.fn()
const isAutoSendDiagnosticsEnabled = vi.fn()

vi.mock('@/components/diagnostics/incident-report-provider', () => ({
  useReportIncident: () => openReport
}))
vi.mock('@/services/diagnostics-service', () => ({
  diagnosticsService: {
    previewReport: (...args: unknown[]) => previewReport(...args),
    sendReport: (...args: unknown[]) => sendReport(...args)
  }
}))
vi.mock('@/hooks/use-telemetry-settings', () => ({
  isAutoSendDiagnosticsEnabled: () => isAutoSendDiagnosticsEnabled()
}))
vi.mock('@/lib/telemetry-diagnostics', () => ({ trackRendererError: vi.fn() }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))

import { TabErrorBoundary } from './tab-error-boundary'

const SEND_LABEL = 'phaseF.componentsTabsTabErrorBoundary.sendReport'

function Boom(): never {
  throw new Error('boom')
}

describe('TabErrorBoundary diagnostic reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    previewReport.mockResolvedValue({ success: true, report: { incidentId: 'MEMRY-ABC123' } })
    sendReport.mockResolvedValue({ success: true, incidentId: 'MEMRY-ABC123' })
  })

  it('sends the report automatically and hides the button when auto-send is on', async () => {
    isAutoSendDiagnosticsEnabled.mockResolvedValue(true)

    render(
      <TabErrorBoundary>
        <Boom />
      </TabErrorBoundary>
    )

    await waitFor(() => expect(sendReport).toHaveBeenCalledTimes(1))
    expect(previewReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'tab_error_boundary' })
    )
    expect(screen.queryByText(SEND_LABEL)).toBeNull()
  })

  it('shows the Send button and sends nothing when auto-send is off', async () => {
    isAutoSendDiagnosticsEnabled.mockResolvedValue(false)

    render(
      <TabErrorBoundary>
        <Boom />
      </TabErrorBoundary>
    )

    const button = await screen.findByText(SEND_LABEL)
    expect(previewReport).not.toHaveBeenCalled()
    button.click()
    expect(openReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'tab_error_boundary' })
    )
  })

  it('falls back to the Send button when the automatic send fails', async () => {
    isAutoSendDiagnosticsEnabled.mockResolvedValue(true)
    sendReport.mockResolvedValue({ success: false, error: 'offline' })

    render(
      <TabErrorBoundary>
        <Boom />
      </TabErrorBoundary>
    )

    expect(await screen.findByText(SEND_LABEL)).toBeTruthy()
  })
})
