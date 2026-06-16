export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

export interface CsvImportNote {
  title: string
  content: string
  folder: string
  properties: Record<string, string>
}

export interface CsvImportStats {
  notes: number
  skipped: number
}

export interface CsvImportPlan {
  notes: CsvImportNote[]
  stats: CsvImportStats
  sampleTitles: string[]
  warnings: string[]
  columns: string[]
  titleColumn: string
}

export interface MapRowsOptions {
  titleColumn?: string
  bodyTemplate?: string
  folder?: string
  propertyColumns?: string[]
}
