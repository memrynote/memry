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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- zod's `error` option is an issue callback when it is a function; its parameter type is zod-internal
    return typeof previous === 'function' ? (previous as ErrorFn)(issue) : undefined
  }
}

// Zod's `_zod.def` is a per-type union with no common shape. These readers sit behind a
// `def.type` check, so the value they take is the schema or schema collection that type holds.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- def.type was checked by the caller
const schemaAt = (value: unknown): z.ZodType => value as z.ZodType
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- def.type was checked by the caller
const schemaList = (value: unknown): z.ZodType[] => value as z.ZodType[]
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- def.type was checked by the caller
const schemaShape = (value: unknown): Record<string, z.ZodType> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- def.type was checked by the caller
  value as Record<string, z.ZodType>
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- def.type was checked by the caller
const schemaGetter = (value: unknown): (() => z.ZodType) => value as () => z.ZodType
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- clone() takes the def of schema's own type, which a generic ZodType cannot name
const cloneWith = (schema: z.ZodType, def: Record<string, unknown>): z.ZodType =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- clone() takes the def of schema's own type, which a generic ZodType cannot name
  schema.clone(def as never)

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
 * values, tuple items and lazy schemas are rebuilt around their strict inner schema, and
 * descriptions are carried over. A recursive lazy schema maps to one strict
 * lazy schema, so the walk ends.
 */
export function strictDeep(schema: z.ZodType, seen = new Map<z.ZodType, z.ZodType>()): z.ZodType {
  const known = seen.get(schema)
  if (known) return known
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- zod's def union has no common shape; this reads only `type` plus the keys each branch below checks
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string }
  const strict = (inner: z.ZodType): z.ZodType => strictDeep(inner, seen)
  let next: z.ZodType
  if (def.type === 'lazy') {
    const getter = schemaGetter(def.getter)
    next = z.lazy(() => strict(getter()))
    seen.set(schema, next)
  } else if (def.type === 'record') {
    next = cloneWith(schema, { ...def, valueType: strict(schemaAt(def.valueType)) })
  } else if (def.type === 'object') {
    const shape = Object.fromEntries(
      Object.entries(schemaShape(def.shape)).map(([key, value]) => [key, strict(value)])
    )
    next = cloneWith(schema, {
      ...def,
      shape,
      ...(def.catchall ? {} : { catchall: z.never(), error: unknownKeyError(def.error) })
    })
  } else if (def.type === 'array') {
    next = cloneWith(schema, { ...def, element: strict(schemaAt(def.element)) })
  } else if (def.type === 'tuple') {
    next = cloneWith(schema, {
      ...def,
      items: schemaList(def.items).map(strict),
      rest: def.rest ? strict(schemaAt(def.rest)) : def.rest
    })
  } else if (def.type === 'union') {
    next = cloneWith(schema, {
      ...def,
      options: schemaList(def.options).map(strict)
    })
  } else if (WRAPPER_TYPES.has(def.type)) {
    next = cloneWith(schema, { ...def, innerType: strict(schemaAt(def.innerType)) })
  } else {
    return schema
  }
  const meta = z.globalRegistry.get(schema)
  if (meta) z.globalRegistry.add(next, meta)
  return next
}
