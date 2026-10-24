import type { ZodType } from 'zod'

import { AgentToolError } from '../errors'

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter is the caller's assertion about data crossing an untyped boundary (JSON, IPC, mock lookup) or a type-level equality check
export function parse<T>(schema: ZodType, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- T is the output type the caller names for this zod schema; parse() has just validated r.data against it
  return r.data as T
}
