import { z } from 'zod'

type ErrorFn = (issue: { code?: string; keys?: string[] }) => string | undefined

function unknownKeyError(previous: unknown): ErrorFn {
  return (issue) => {
    if (issue.code === 'unrecognized_keys') {
      return (
        `Unknown argument: ${(issue.keys ?? []).join(', ')}. ` +
        'Remove it; this call takes only the arguments in its schema.'
      )
    }
    return typeof previous === 'function' ? (previous as ErrorFn)(issue) : undefined
  }
}

const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'nonoptional',
  'catch'
])

/**
 * Every object at every depth refuses keys it does not name, unless it already
 * says what to do with them (a catchall). Wrappers, arrays and unions are
 * rebuilt around their strict inner schema, and descriptions are carried over.
 */
export function strictDeep(schema: z.ZodType): z.ZodType {
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string }
  let next: z.ZodType
  if (def.type === 'object') {
    const shape = Object.fromEntries(
      Object.entries(def.shape as Record<string, z.ZodType>).map(([key, value]) => [
        key,
        strictDeep(value)
      ])
    )
    next = schema.clone({
      ...def,
      shape,
      ...(def.catchall ? {} : { catchall: z.never(), error: unknownKeyError(def.error) })
    } as never)
  } else if (def.type === 'array') {
    next = schema.clone({ ...def, element: strictDeep(def.element as z.ZodType) } as never)
  } else if (def.type === 'union') {
    next = schema.clone({
      ...def,
      options: (def.options as z.ZodType[]).map(strictDeep)
    } as never)
  } else if (WRAPPER_TYPES.has(def.type)) {
    next = schema.clone({ ...def, innerType: strictDeep(def.innerType as z.ZodType) } as never)
  } else {
    return schema
  }
  const meta = z.globalRegistry.get(schema)
  if (meta) z.globalRegistry.add(next, meta)
  return next
}
