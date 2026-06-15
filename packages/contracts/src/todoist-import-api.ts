import { z } from 'zod'

export const TodoistImportStatsSchema = z.object({
  rows: z.number(),
  tasks: z.number(),
  subtasks: z.number(),
  withDueDate: z.number(),
  comments: z.number(),
  sectionsFlattened: z.number(),
  skipped: z.number()
})
export type TodoistImportStats = z.infer<typeof TodoistImportStatsSchema>

export const TodoistPreviewFileSchema = z.object({
  fileName: z.string(),
  projectName: z.string(),
  stats: TodoistImportStatsSchema,
  sampleTitles: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z.string().optional()
})
export type TodoistPreviewFile = z.infer<typeof TodoistPreviewFileSchema>

export const TodoistPreviewResponseSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    filePaths: z.array(z.string()),
    files: z.array(TodoistPreviewFileSchema)
  })
])
export type TodoistPreviewResponse = z.infer<typeof TodoistPreviewResponseSchema>

export const TodoistImportRunSchema = z.object({
  filePaths: z.array(z.string()).min(1)
})
export type TodoistImportRunInput = z.infer<typeof TodoistImportRunSchema>

export const TodoistImportFileResultSchema = z.object({
  projectName: z.string(),
  projectId: z.string().nullable(),
  stats: TodoistImportStatsSchema,
  warnings: z.array(z.string()),
  error: z.string().optional()
})
export type TodoistImportFileResult = z.infer<typeof TodoistImportFileResultSchema>

export const TodoistImportSummarySchema = z.object({
  files: z.array(TodoistImportFileResultSchema)
})
export type TodoistImportSummary = z.infer<typeof TodoistImportSummarySchema>
