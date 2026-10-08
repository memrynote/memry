import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'

export function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}
