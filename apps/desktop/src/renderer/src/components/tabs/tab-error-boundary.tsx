/**
 * Tab System Error Boundary
 * Error boundary for graceful tab content error handling
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useReportIncident } from '@/components/diagnostics/incident-report-provider'
import { isAutoSendDiagnosticsEnabled } from '@/hooks/use-telemetry-settings'
import { diagnosticsService, type DiagnosticTrigger } from '@/services/diagnostics-service'
import { useT } from '@memry/i18n/renderer'
import { toErrorCode } from '@memry/contracts/telemetry-api'

const log = createLogger('Component:TabErrorBoundary')

interface TabErrorBoundaryProps {
  /** Children to render */
  children: ReactNode
  /** Fallback callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** Remove the tab that cannot render, so a persisted failure cannot strand the app. */
  onCloseTab?: () => void
}

interface TabErrorBoundaryImplProps extends TabErrorBoundaryProps {
  /** Opens the consent dialog for a manual diagnostic report */
  onReport?: (error: Error) => void
  /**
   * Sends the report without asking when the user allows it. Resolves true when
   * the report was handled automatically, false when the manual button is needed.
   */
  onAutoReport?: (error: Error) => Promise<boolean>
}

interface TabErrorBoundaryLabels {
  somethingWentWrong: string
  errorOccurred: string
  tryAgain: string
  sendReport: string
  closeTab: string
}

interface TabErrorBoundaryState {
  hasError: boolean
  error: Error | null
  /** pending: auto-send decision in flight; auto: handled; manual: show the Send button */
  reportMode: 'pending' | 'auto' | 'manual'
}

/**
 * Error boundary for tab content
 * Shows fallback UI when content crashes
 */
class TabErrorBoundaryImpl extends Component<
  TabErrorBoundaryImplProps & { labels: TabErrorBoundaryLabels },
  TabErrorBoundaryState
> {
  constructor(props: TabErrorBoundaryImplProps & { labels: TabErrorBoundaryLabels }) {
    super(props)
    this.state = { hasError: false, error: null, reportMode: 'pending' }
  }

  static getDerivedStateFromError(error: Error): Partial<TabErrorBoundaryState> {
    return { hasError: true, error, reportMode: 'pending' }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error('Tab content error', error, errorInfo)
    trackRendererError('tab_error_boundary', error)
    this.props.onError?.(error, errorInfo)
    const autoReport = this.props.onAutoReport
    if (!autoReport) {
      this.setState({ reportMode: 'manual' })
      return
    }
    void autoReport(error)
      .catch(() => false)
      .then((handled) => {
        if (this.state.error !== error) return
        this.setState({ reportMode: handled ? 'auto' : 'manual' })
      })
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, reportMode: 'pending' })
  }

  handleReport = (): void => {
    if (this.state.error) this.props.onReport?.(this.state.error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const { labels } = this.props
      return (
        <div className="h-full flex items-center justify-center p-8">
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-amber-500" />
            <h2 className="text-lg font-medium text-foreground">{labels.somethingWentWrong}</h2>
            <p className="text-sm text-muted-foreground">{labels.errorOccurred}</p>
            {this.state.error && (
              <code className="text-xs bg-muted p-2 rounded text-red-500 max-w-full overflow-auto">
                {this.state.error.message}
              </code>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {this.props.onCloseTab && (
                <button
                  type="button"
                  onClick={this.props.onCloseTab}
                  className="flex items-center gap-2 px-4 py-2 bg-tint text-tint-foreground rounded-md hover:bg-tint-hover transition-colors"
                >
                  {labels.closeTab}
                </button>
              )}
              <button
                type="button"
                onClick={this.handleRetry}
                className="flex items-center gap-2 px-4 py-2 border border-border rounded-md hover:bg-muted transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {labels.tryAgain}
              </button>
              {this.state.reportMode === 'manual' && (
                <button
                  type="button"
                  onClick={this.handleReport}
                  className="flex items-center gap-2 px-4 py-2 border border-border rounded-md hover:bg-muted transition-colors"
                >
                  {labels.sendReport}
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const toTrigger = (error: Error): DiagnosticTrigger => ({
  source: 'tab_error_boundary',
  errorCode: toErrorCode(error),
  stack: error.stack
})

/** Builds and sends the report without UI when the user allows it (Settings > Privacy). */
async function autoSendReport(error: Error): Promise<boolean> {
  if (!(await isAutoSendDiagnosticsEnabled())) return false
  const preview = await diagnosticsService.previewReport(toTrigger(error))
  if (!preview.success) {
    log.warn('Auto diagnostic report preview failed', { error: preview.error })
    return false
  }
  const sent = await diagnosticsService.sendReport(preview.report)
  if (!sent.success) {
    log.warn('Auto diagnostic report send failed', { error: sent.error })
    return false
  }
  log.info('Auto diagnostic report sent', { incidentId: sent.incidentId })
  return true
}

export function TabErrorBoundary(props: TabErrorBoundaryProps): ReactNode {
  const { t } = useT('common')
  const open = useReportIncident()
  return (
    <TabErrorBoundaryImpl
      {...props}
      onReport={(error) => open(toTrigger(error))}
      onAutoReport={autoSendReport}
      labels={{
        somethingWentWrong: t('phaseF.componentsTabsTabErrorBoundary.somethingWentWrong'),
        errorOccurred: t(
          'phaseF.componentsTabsTabErrorBoundary.anErrorOccurredWhileRenderingThisTabContent'
        ),
        tryAgain: t('phaseF.componentsTabsTabErrorBoundary.tryAgain'),
        sendReport: t('phaseF.componentsTabsTabErrorBoundary.sendReport'),
        closeTab: t('button.close')
      }}
    />
  )
}

export default TabErrorBoundary
