import { z } from 'zod'
import {
  desktopOperationArgsSchema,
  desktopOperationParamNames
} from '@memry/contracts/agent-desktop-api-args'
import type { AgentMcpDesktopOperation } from '@memry/contracts/agent-mcp-channels'

/** One reason a desktop API call was refused, in terms an agent can act on. */
export interface DesktopArgIssue {
  /** The parameter name, then the key path inside it ("scope.path"). */
  field: string
  /** A key the operation does not take. */
  unknown?: true
  /** The type the field takes, written like TypeScript. */
  expected?: string
  /** The values the field takes, when it takes a fixed set. */
  allowed?: unknown[]
  /** A limit the value broke, in zod's words. */
  problem?: string
  received?: string
}

type KeyPath = readonly PropertyKey[]
type JsonNode = Record<string, unknown>

const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'nonoptional',
  'catch'
])
const EXPECTED_MAX_CHARS = 400
const RECEIVED_MAX_CHARS = 60
const RENDER_MAX_DEPTH = 3

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  for (;;) {
    const def = current._zod.def as unknown as JsonNode & { type: string }
    if (WRAPPER_TYPES.has(def.type)) current = def.innerType as z.ZodType
    else if (def.type === 'lazy') current = (def.getter as () => z.ZodType)()
    else if (def.type === 'pipe') current = def.in as z.ZodType
    else return current
  }
}

function childSchema(schema: z.ZodType, key: PropertyKey): z.ZodType | undefined {
  const inner = unwrap(schema)
  const def = inner._zod.def as unknown as JsonNode & { type: string }
  switch (def.type) {
    case 'tuple':
      return (def.items as z.ZodType[])[Number(key)] ?? (def.rest as z.ZodType | undefined)
    case 'object':
      return (def.shape as Record<string, z.ZodType>)[String(key)]
    case 'array':
      return def.element as z.ZodType
    case 'record':
      return def.valueType as z.ZodType
    case 'union': {
      const found = (def.options as z.ZodType[])
        .map((option) => childSchema(option, key))
        .filter((option): option is z.ZodType => option !== undefined)
      if (found.length === 0) return undefined
      return found.length === 1 ? found[0] : z.union(found as [z.ZodType, z.ZodType])
    }
    default:
      return undefined
  }
}

function schemaAt(schema: z.ZodType, path: KeyPath): z.ZodType | undefined {
  let current: z.ZodType | undefined = schema
  for (const key of path) {
    if (!current) return undefined
    current = childSchema(current, key)
  }
  return current
}

function valueAt(value: unknown, path: KeyPath): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

/** The fixed values a schema takes, or null when it takes more than literals. */
function literalValues(node: JsonNode): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum
  if ('const' in node) return [node.const]
  const options = (node.anyOf ?? node.oneOf) as JsonNode[] | undefined
  if (!options) return null
  const values: unknown[] = []
  for (const option of options) {
    const found = literalValues(option)
    if (!found) return null
    values.push(...found)
  }
  return values
}

function resolveRef(ref: string, root: JsonNode): JsonNode | undefined {
  if (ref === '#') return root
  const name = ref.replace(/^#\/\$defs\//, '')
  return (root.$defs as Record<string, JsonNode> | undefined)?.[name]
}

function renderType(node: JsonNode, root: JsonNode, depth: number): string {
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root)
    return target && depth < RENDER_MAX_DEPTH ? renderType(target, root, depth + 1) : 'object'
  }
  const literals = literalValues(node)
  if (literals) return literals.map((value) => JSON.stringify(value)).join(' | ')
  const options = (node.anyOf ?? node.oneOf) as JsonNode[] | undefined
  if (options) {
    return [...new Set(options.map((option) => renderType(option, root, depth)))].join(' | ')
  }
  const type = node.type
  if (Array.isArray(type)) {
    return type.map((member) => renderType({ ...node, type: member }, root, depth)).join(' | ')
  }
  if (type === 'array') {
    if (Array.isArray(node.prefixItems)) {
      const items = (node.prefixItems as JsonNode[]).map((item) => renderType(item, root, depth))
      return `[${items.join(', ')}]`
    }
    const item = node.items ? renderType(node.items as JsonNode, root, depth + 1) : 'any'
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`
  }
  if (type === 'object') {
    const properties = node.properties as Record<string, JsonNode> | undefined
    if (depth >= RENDER_MAX_DEPTH) return 'object'
    if (properties && Object.keys(properties).length > 0) {
      const required = new Set((node.required as string[] | undefined) ?? [])
      const fields = Object.entries(properties).map(
        ([key, value]) =>
          `${key}${required.has(key) ? '' : '?'}: ${renderType(value, root, depth + 1)}`
      )
      return `{ ${fields.join(', ')} }`
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      return `Record<string, ${renderType(node.additionalProperties as JsonNode, root, depth + 1)}>`
    }
    return 'object'
  }
  return typeof type === 'string' ? type : 'any'
}

/** What a field takes, written for the agent: "one of …" for a fixed set. */
function describeExpected(schema: z.ZodType): Pick<DesktopArgIssue, 'expected' | 'allowed'> {
  const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonNode
  const literals = literalValues(root)
  if (literals && literals.length > 1) {
    return {
      expected: `one of ${literals.map((value) => JSON.stringify(value)).join(', ')}`,
      allowed: literals
    }
  }
  const rendered = renderType(root, root, 0)
  return {
    expected:
      rendered.length > EXPECTED_MAX_CHARS ? `${rendered.slice(0, EXPECTED_MAX_CHARS)}…` : rendered,
    ...(literals ? { allowed: literals } : {})
  }
}

function describeReceived(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') {
    const shown =
      value.length > RECEIVED_MAX_CHARS ? `${value.slice(0, RECEIVED_MAX_CHARS)}...` : value
    return JSON.stringify(shown)
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value
}

/**
 * A union option that failed on the value's own type or on a literal key (the
 * discriminator) is not the option the value was meant for.
 */
function missesOption(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.path.length === 0 || (issue.code === 'invalid_value' && issue.path.length === 1)
  )
}

function onlyUnknownKeys(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.every(
    (issue) =>
      issue.code === 'unrecognized_keys' ||
      (issue.code === 'invalid_union' && issue.errors.some(onlyUnknownKeys))
  )
}

/**
 * Turns zod's issues for a desktop API call into one entry per field. A union
 * that fails as a whole is narrowed to the option the value was meant for
 * when exactly one fits, and otherwise reported with every shape it takes.
 */
export function desktopArgIssues(
  operation: AgentMcpDesktopOperation,
  args: readonly unknown[],
  issues: readonly z.core.$ZodIssue[]
): DesktopArgIssue[] {
  const schema = desktopOperationArgsSchema(operation)
  const names = desktopOperationParamNames(operation)
  const field = (path: KeyPath): string =>
    path.length === 0
      ? 'args'
      : [names[Number(path[0])] ?? `args.${String(path[0])}`, ...path.slice(1).map(String)].join(
          '.'
        )
  const atPath = (path: KeyPath): DesktopArgIssue => {
    const target = schemaAt(schema, path)
    return {
      field: field(path),
      ...(target ? describeExpected(target) : {}),
      received: describeReceived(valueAt(args, path))
    }
  }

  const collect = (list: readonly z.core.$ZodIssue[], at: KeyPath): DesktopArgIssue[] =>
    list.flatMap((issue): DesktopArgIssue[] => {
      const path = [...at, ...issue.path]
      switch (issue.code) {
        case 'unrecognized_keys':
          return issue.keys.map((key) => ({ field: field([...path, key]), unknown: true }))
        case 'invalid_union': {
          const meant =
            issue.errors.find(onlyUnknownKeys) ??
            (issue.errors.filter((option) => !missesOption(option)).length === 1
              ? issue.errors.find((option) => !missesOption(option))
              : undefined)
          return meant ? collect(meant, path) : [atPath(path)]
        }
        case 'invalid_type':
          return [atPath(path)]
        case 'invalid_value':
          return [
            {
              field: field(path),
              expected:
                issue.values.length === 1
                  ? JSON.stringify(issue.values[0])
                  : `one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`,
              allowed: [...issue.values],
              received: describeReceived(valueAt(args, path))
            }
          ]
        default:
          return [
            {
              field: field(path),
              problem: issue.message,
              received: describeReceived(valueAt(args, path))
            }
          ]
      }
    })

  return collect(issues, [])
}

export function formatDesktopArgIssue(issue: DesktopArgIssue): string {
  if (issue.unknown) return `${issue.field}: not a parameter of this operation`
  if (issue.expected) return `${issue.field}: expected ${issue.expected}, got ${issue.received}`
  return `${issue.field}: ${issue.problem ?? 'invalid'}, got ${issue.received}`
}
