/**
 * TickTick import IPC contract types.
 *
 * @module contracts/ticktick-import-api
 */

export interface TickTickImportWarning {
  message: string
  row?: number
}

export interface TickTickImportStats {
  rows: number
  projects: number
  tasks: number
  subtasks: number
  reminders: number
}

export interface TickTickImportSummary {
  canceled: boolean
  stats: TickTickImportStats
  warnings: TickTickImportWarning[]
}
