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
 * says what to do with them (a catchall). Wrappers, arrays, unions, record
 * values and lazy schemas are rebuilt around their strict inner schema, and
 * descriptions are carried over. A recursive lazy schema maps to one strict
 * lazy schema, so the walk ends.
 */
export function strictDeep(schema: z.ZodType, seen = new Map<z.ZodType, z.ZodType>()): z.ZodType {
  const known = seen.get(schema)
  if (known) return known
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string }
  const strict = (inner: z.ZodType): z.ZodType => strictDeep(inner, seen)
  let next: z.ZodType
  if (def.type === 'lazy') {
    const getter = def.getter as () => z.ZodType
    next = z.lazy(() => strict(getter()))
    seen.set(schema, next)
  } else if (def.type === 'record') {
    next = schema.clone({ ...def, valueType: strict(def.valueType as z.ZodType) } as never)
  } else if (def.type === 'object') {
    const shape = Object.fromEntries(
      Object.entries(def.shape as Record<string, z.ZodType>).map(([key, value]) => [
        key,
        strict(value)
      ])
    )
    next = schema.clone({
      ...def,
      shape,
      ...(def.catchall ? {} : { catchall: z.never(), error: unknownKeyError(def.error) })
    } as never)
  } else if (def.type === 'array') {
    next = schema.clone({ ...def, element: strict(def.element as z.ZodType) } as never)
  } else if (def.type === 'union') {
    next = schema.clone({
      ...def,
      options: (def.options as z.ZodType[]).map(strict)
    } as never)
  } else if (WRAPPER_TYPES.has(def.type)) {
    next = schema.clone({ ...def, innerType: strict(def.innerType as z.ZodType) } as never)
  } else {
    return schema
  }
  const meta = z.globalRegistry.get(schema)
  if (meta) z.globalRegistry.add(next, meta)
  return next
}
