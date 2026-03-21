/**
 * Tab System Error Boundary
 * Error boundary for graceful tab content error handling
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from '@/lib/icons'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:TabErrorBoundary')

interface TabErrorBoundaryProps {
  /** Children to render */
  children: ReactNode
  /** Fallback callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface TabErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary for tab content
 * Shows fallback UI when content crashes
 */
export class TabErrorBoundary extends Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  constructor(props: TabErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error('Tab content error', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-full flex items-center justify-center p-8">
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-amber-500" />
            <h2 className="text-lg font-medium text-foreground">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
              An error occurred while rendering this tab content.
            </p>
            {this.state.error && (
              <code className="text-xs bg-muted p-2 rounded text-red-500 max-w-full overflow-auto">
                {this.state.error.message}
              </code>
            )}
            <button
              onClick={this.handleRetry}
              className="flex items-center gap-2 px-4 py-2 bg-tint text-tint-foreground rounded-md hover:bg-tint-hover transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default TabErrorBoundary
