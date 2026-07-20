/**
 * Tab System Error Boundary
 * Error boundary for graceful tab content error handling
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useReportIncident } from '@/components/diagnostics/incident-report-provider'
import { useT } from '@memry/i18n/renderer'
import { toErrorCode } from '@memry/contracts/telemetry-api'

const log = createLogger('Component:TabErrorBoundary')

interface TabErrorBoundaryProps {
  /** Children to render */
  children: ReactNode
  /** Fallback callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface TabErrorBoundaryImplProps extends TabErrorBoundaryProps {
  /** Fallback callback to offer a diagnostic incident report for the caught error */
  onReport?: (error: Error) => void
}

interface TabErrorBoundaryLabels {
  somethingWentWrong: string
  errorOccurred: string
  tryAgain: string
  sendReport: string
}

interface TabErrorBoundaryState {
  hasError: boolean
  error: Error | null
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
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error('Tab content error', error, errorInfo)
    trackRendererError('tab_error_boundary', error)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={this.handleRetry}
                className="flex items-center gap-2 px-4 py-2 bg-tint text-tint-foreground rounded-md hover:bg-tint-hover transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {labels.tryAgain}
              </button>
              <button
                type="button"
                onClick={this.handleReport}
                className="flex items-center gap-2 px-4 py-2 border border-border rounded-md hover:bg-muted transition-colors"
              >
                {labels.sendReport}
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export function TabErrorBoundary(props: TabErrorBoundaryProps): ReactNode {
  const { t } = useT('common')
  const open = useReportIncident()
  return (
    <TabErrorBoundaryImpl
      {...props}
      onReport={(error) =>
        open({ source: 'tab_error_boundary', errorCode: toErrorCode(error), stack: error.stack })
      }
      labels={{
        somethingWentWrong: t('phaseF.componentsTabsTabErrorBoundary.somethingWentWrong'),
        errorOccurred: t(
          'phaseF.componentsTabsTabErrorBoundary.anErrorOccurredWhileRenderingThisTabContent'
        ),
        tryAgain: t('phaseF.componentsTabsTabErrorBoundary.tryAgain'),
        sendReport: t('phaseF.componentsTabsTabErrorBoundary.sendReport')
      }}
    />
  )
}

export default TabErrorBoundary
