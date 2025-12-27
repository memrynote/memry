/**
 * Journal Error Boundary
 *
 * Error boundary specifically for the Journal page components.
 * Provides graceful error handling when journal components crash,
 * preserving content in memory and allowing recovery.
 *
 * @module components/journal/journal-error-boundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface JournalErrorBoundaryProps {
  /** Children to render (the journal content) */
  children: ReactNode
  /** Current date for context */
  date?: string
  /** Callback when user triggers recovery */
  onRecover?: () => void
  /** Callback when error occurs (for logging) */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** Pending content that might not have been saved */
  pendingContent?: string
}

interface JournalErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary for Journal page components.
 * Shows a friendly fallback UI when journal components crash.
 */
export class JournalErrorBoundary extends Component<
  JournalErrorBoundaryProps,
  JournalErrorBoundaryState
> {
  constructor(props: JournalErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): JournalErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[JournalErrorBoundary] Journal crash:', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onRecover?.()
  }

  handleCopyContent = (): void => {
    if (this.props.pendingContent) {
      navigator.clipboard.writeText(this.props.pendingContent)
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className="h-full flex items-center justify-center p-8 bg-background"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <div
              className="flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30"
              aria-hidden="true"
            >
              <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">Journal Error</h2>
            <p className="text-sm text-muted-foreground">
              The journal encountered an error
              {this.props.date && (
                <>
                  {' '}
                  for <span className="font-medium">{this.props.date}</span>
                </>
              )}
              . Your recent changes may not have been saved.
            </p>

            {/* Pending content recovery */}
            {this.props.pendingContent && (
              <div className="w-full p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800/50">
                <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
                  Unsaved content detected ({this.props.pendingContent.length} characters)
                </p>
                <Button
                  onClick={this.handleCopyContent}
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                >
                  Copy unsaved content to clipboard
                </Button>
              </div>
            )}

            {this.state.error && (
              <details className="w-full">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  Technical details
                </summary>
                <code className="mt-2 block text-xs bg-muted p-2 rounded overflow-auto max-h-24 text-left">
                  {this.state.error.message}
                  {this.state.error.stack && (
                    <>
                      {'\n\n'}
                      {this.state.error.stack}
                    </>
                  )}
                </code>
              </details>
            )}
            <div className="flex gap-2 mt-2">
              <Button
                onClick={this.handleRetry}
                variant="default"
                size="sm"
                aria-label="Reload the journal to try again"
              >
                <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
                Reload Journal
              </Button>
              <Button
                onClick={() => window.location.reload()}
                variant="outline"
                size="sm"
                aria-label="Go to today's journal entry"
              >
                <Calendar className="w-4 h-4 mr-2" aria-hidden="true" />
                Go to Today
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default JournalErrorBoundary
