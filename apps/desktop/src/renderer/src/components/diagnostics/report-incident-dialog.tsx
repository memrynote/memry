/**
 * ReportIncidentDialog
 *
 * Consent + preview dialog for Path B one-time diagnostic incident reports.
 * The preview renders the exact `DiagnosticReport` that Send transmits —
 * preview IS the payload, nothing is regenerated between preview and send.
 *
 * @module components/diagnostics/report-incident-dialog
 */

import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, CheckCircle, AlertTriangle, ChevronDown } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import {
  diagnosticsService,
  type DiagnosticReport,
  type DiagnosticTrigger
} from '@/services/diagnostics-service'

interface ReportIncidentDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** The trigger that prompted the report; null while no report is pending */
  trigger: DiagnosticTrigger | null
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
}

type Phase = 'building' | 'preview' | 'previewError' | 'sending' | 'sent'

export function ReportIncidentDialog({
  open,
  trigger,
  onOpenChange
}: ReportIncidentDialogProps): React.ReactElement {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')

  const [phase, setPhase] = useState<Phase>('building')
  const [report, setReport] = useState<DiagnosticReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [sentIncidentId, setSentIncidentId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !trigger) return

    let cancelled = false
    setPhase('building')
    setReport(null)
    setError(null)
    setShowPreview(false)
    setSentIncidentId(null)

    diagnosticsService
      .previewReport(trigger)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setReport(result.report)
          setPhase('preview')
        } else {
          setError(extractErrorMessage(result.error, t('general.privacy.diagnostics.error')))
          setPhase('previewError')
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(extractErrorMessage(err, t('general.privacy.diagnostics.error')))
        setPhase('previewError')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trigger])

  const handleSend = useCallback(() => {
    if (!report || phase !== 'preview') return
    setPhase('sending')
    diagnosticsService
      .sendReport(report)
      .then((result) => {
        if (result.success) {
          setSentIncidentId(result.incidentId)
          setPhase('sent')
          toast.success(t('general.privacy.diagnostics.sent', { incidentId: result.incidentId }))
        } else {
          setPhase('preview')
          toast.error(extractErrorMessage(result.error, t('general.privacy.diagnostics.error')))
        }
      })
      .catch((err: unknown) => {
        setPhase('preview')
        toast.error(extractErrorMessage(err, t('general.privacy.diagnostics.error')))
      })
  }, [report, phase, t])

  const handleNotNow = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('general.privacy.diagnostics.title')}</DialogTitle>
          <DialogDescription>{t('general.privacy.diagnostics.consent')}</DialogDescription>
        </DialogHeader>

        {phase === 'building' && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('general.privacy.diagnostics.building')}</span>
          </div>
        )}

        {phase === 'previewError' && (
          <div className="flex items-start gap-2 py-4 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {(phase === 'preview' || phase === 'sending') && report && (
          <div className="space-y-2 py-2">
            <Collapsible open={showPreview} onOpenChange={setShowPreview}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-between">
                  {t('general.privacy.diagnostics.previewLabel')}
                  <ChevronDown
                    className={cn('h-4 w-4 transition-transform', showPreview && 'rotate-180')}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ScrollArea className="mt-2 h-64 rounded-md border p-3">
                  <div className="space-y-2 font-mono text-xs">
                    {report.lines.map((line, index) => (
                      <div key={index} className="border-b border-border pb-2 last:border-0">
                        <div className="text-muted-foreground">
                          [{line.scope}] {line.level}
                        </div>
                        <div>{line.message}</div>
                        {line.fields && (
                          <pre className="whitespace-pre-wrap text-muted-foreground">
                            {JSON.stringify(line.fields, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="mb-1 text-xs text-muted-foreground">
                      {t('general.privacy.diagnostics.snapshotLabel')}
                    </div>
                    <pre className="whitespace-pre-wrap font-mono text-xs">
                      {JSON.stringify(report.snapshot, null, 2)}
                    </pre>
                  </div>
                </ScrollArea>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {phase === 'sent' && sentIncidentId && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>{t('general.privacy.diagnostics.sent', { incidentId: sentIncidentId })}</span>
          </div>
        )}

        <DialogFooter>
          {phase === 'sent' || phase === 'previewError' ? (
            <Button onClick={() => onOpenChange(false)}>{tCommon('button.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleNotNow} disabled={phase === 'sending'}>
                {t('general.privacy.diagnostics.notNow')}
              </Button>
              <Button
                onPointerDown={handleSend}
                onClick={handleSend}
                disabled={phase !== 'preview'}
              >
                {phase === 'sending' ? (
                  <>
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                    {t('general.privacy.diagnostics.sending')}
                  </>
                ) : (
                  t('general.privacy.diagnostics.send')
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
