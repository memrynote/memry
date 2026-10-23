import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter is the caller's assertion about data crossing an untyped boundary (JSON, IPC, mock lookup) or a type-level equality check
export function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}
