/**
 * IncidentReportProvider
 *
 * Mounts a single `ReportIncidentDialog` instance high in the tree so both the
 * tab error boundary and the Settings privacy row can trigger a Path B
 * diagnostic report without each owning their own dialog.
 *
 * @module components/diagnostics/incident-report-provider
 */

import { createContext, useContext, type ReactNode } from 'react'
import { useIncidentReport } from '@/hooks/use-incident-report'
import type { DiagnosticTrigger } from '@/services/diagnostics-service'

type ReportIncidentFn = (trigger: DiagnosticTrigger) => void

const IncidentReportContext = createContext<ReportIncidentFn | null>(null)

export function IncidentReportProvider({ children }: { children: ReactNode }): ReactNode {
  const { open, dialog } = useIncidentReport()

  return (
    <IncidentReportContext.Provider value={open}>
      {children}
      {dialog}
    </IncidentReportContext.Provider>
  )
}

/** Opens the shared consent + preview dialog from any surface inside IncidentReportProvider. */
export function useReportIncident(): ReportIncidentFn {
  const open = useContext(IncidentReportContext)
  if (!open) {
    throw new Error('useReportIncident must be used within an IncidentReportProvider')
  }
  return open
}
