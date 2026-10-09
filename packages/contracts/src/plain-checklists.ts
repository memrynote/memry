import { z } from 'zod'

/**
 * `plainChecklists` marks each checkbox line a write adds with `{check}`, so the
 * editor keeps it a checkbox. Main sets it on every agent call (#2759).
 */
const plainChecklists = z
  .boolean()
  .optional()
  .describe(
    "Set by memrynote on every agent call from the owner's agent checklist setting; " +
      'a value you pass is replaced.'
  )

export const PlainChecklistsOptionSchema = z.object({ plainChecklists })
export type PlainChecklistsOption = z.infer<typeof PlainChecklistsOptionSchema>
