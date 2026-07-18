import type { DiagnosticReport, DiagnosticTrigger } from '../../contracts/src/diagnostics-api.ts'
import { DiagnosticsChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

type PreviewReportResponse = Promise<
  { success: true; report: DiagnosticReport } | { success: false; error: string }
>
type SendReportResponse = Promise<
  { success: true; incidentId: string } | { success: false; error: string }
>

export const diagnosticsRpc = defineDomain({
  name: 'diagnostics',
  methods: {
    previewReport: defineMethod<(trigger: DiagnosticTrigger) => PreviewReportResponse>({
      channel: DiagnosticsChannels.invoke.PREVIEW_REPORT,
      params: ['trigger']
    }),
    sendReport: defineMethod<(report: DiagnosticReport) => SendReportResponse>({
      channel: DiagnosticsChannels.invoke.SEND_REPORT,
      params: ['report']
    })
  },
  events: {}
})

export type DiagnosticsClientAPI = RpcClient<typeof diagnosticsRpc>
