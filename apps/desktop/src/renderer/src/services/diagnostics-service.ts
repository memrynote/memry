import type { DiagnosticReport, DiagnosticTrigger } from '@memry/contracts/diagnostics-api'
import type { DiagnosticsClientAPI } from '@memry/rpc'
import { createWindowApiForwarder } from './window-api-forwarder'

export type { DiagnosticReport, DiagnosticTrigger }

export const diagnosticsService: DiagnosticsClientAPI = createWindowApiForwarder(
  () => window.api.diagnostics
)
