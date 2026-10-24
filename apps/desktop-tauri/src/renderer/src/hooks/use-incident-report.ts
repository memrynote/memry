import { createElement, useCallback, useState, type ReactNode } from 'react'
import { ReportIncidentDialog } from '@/components/diagnostics/report-incident-dialog'
import type { DiagnosticTrigger } from '@/services/diagnostics-service'

interface UseIncidentReportResult {
  /** Opens the consent + preview dialog for a diagnostic trigger. */
  open: (trigger: DiagnosticTrigger) => void
  /** Renders the controlled dialog; mount once wherever the caller lives. */
  dialog: ReactNode
}

/**
 * Single entry point for surfaces that offer a one-time diagnostic incident
 * report (Path B). Owns the trigger + open state and renders the dialog.
 */
export function useIncidentReport(): UseIncidentReportResult {
  const [isOpen, setIsOpen] = useState(false)
  const [trigger, setTrigger] = useState<DiagnosticTrigger | null>(null)

  const open = useCallback((nextTrigger: DiagnosticTrigger) => {
    setTrigger(nextTrigger)
    setIsOpen(true)
  }, [])

  return {
    open,
    dialog: createElement(ReportIncidentDialog, { open: isOpen, trigger, onOpenChange: setIsOpen })
  }
}
