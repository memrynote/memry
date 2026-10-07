import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { desktopOperationJsonSchema } from '@memry/contracts/agent-desktop-api-args'
import { AgentMcpDesktopOperations } from '@memry/contracts/agent-mcp-channels'

import { assertDesktopApiArgs, desktopOperationParams } from '../desktop-api-params'

const desktopRoot = path.resolve(__dirname, '../../../../../..')

interface PreloadParam {
  operation: (typeof AgentMcpDesktopOperations)[number]
  name: string
  index: number
  optional: boolean
  isObject: boolean
  isArray: boolean
  /** JSON Schema kinds the declared type allows; empty for any/unknown. */
  kinds: string[]
  /** The values of a declared union of string literals. */
  literals: string[] | null
}

// Every argument of every allowlisted operation, read from the `window.api`
// declaration.
function preloadParams(): PreloadParam[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(desktopRoot, 'tsconfig.web.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  )
  if (!config) throw new Error('tsconfig.web.json did not parse')
  const declaration = path.join(desktopRoot, 'src/preload/index.d.ts')
  const program = ts.createProgram([declaration], config.options)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(declaration)
  let api: ts.InterfaceDeclaration | undefined
  source?.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'API') api = node
  })
  if (!api) throw new Error('API interface not found in preload/index.d.ts')
  const apiNode = api
  const apiType = checker.getTypeAtLocation(apiNode)
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown
  const isObject = (type: ts.Type): boolean => {
    const value = checker.getNonNullableType(type)
    if (value.isUnion()) return value.types.some(isObject)
    if (checker.isArrayType(value))
      return isObject(checker.getTypeArguments(value as ts.TypeReference)[0])
    if (value.flags & primitive) return false
    return (value.flags & ts.TypeFlags.Object) !== 0
  }
  const kindsOf = (type: ts.Type): string[] => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return []
    const members = type.isUnion() ? type.types : [type]
    const kinds = new Set<string>()
    for (const member of members) {
      if (member.flags & ts.TypeFlags.Undefined) continue
      if (member.flags & ts.TypeFlags.Null) kinds.add('null')
      else if (member.flags & ts.TypeFlags.StringLike) kinds.add('string')
      else if (member.flags & ts.TypeFlags.NumberLike) kinds.add('number')
      else if (member.flags & ts.TypeFlags.BooleanLike) kinds.add('boolean')
      else if (checker.isArrayType(member)) kinds.add('array')
      else kinds.add('object')
    }
    return [...kinds].sort()
  }
  const literalsOf = (type: ts.Type): string[] | null => {
    const members = checker.getNonNullableType(type)
    const options = members.isUnion() ? members.types : [members]
    if (!options.every((option) => option.isStringLiteral())) return null
    return options.map((option) => (option as ts.StringLiteralType).value).sort()
  }

  const params: PreloadParam[] = []
  for (const operation of AgentMcpDesktopOperations) {
    const [domain, method] = operation.split('.')
    const domainSymbol = apiType.getProperty(domain)
    const methodSymbol = domainSymbol
      ? checker.getTypeOfSymbolAtLocation(domainSymbol, apiNode).getProperty(method)
      : undefined
    if (!methodSymbol) throw new Error(`window.api has no ${operation}`)
    const signature = checker
      .getTypeOfSymbolAtLocation(methodSymbol, apiNode)
      .getCallSignatures()[0]
    signature.getParameters().forEach((symbol, index) => {
      const type = checker.getTypeOfSymbolAtLocation(symbol, apiNode)
      const declared = symbol.valueDeclaration
      params.push({
        operation,
        name: symbol.name,
        index,
        optional: Boolean(
          declared && ts.isParameter(declared) && (declared.questionToken || declared.initializer)
        ),
        isObject: isObject(type),
        isArray: checker.isArrayType(checker.getNonNullableType(type)),
        kinds: kindsOf(type),
        literals: literalsOf(type)
      })
    })
  }
  return params
}

type JsonSchema = {
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

function jsonKinds(schema: JsonSchema): string[] {
  const kinds = new Set<string>()
  const visit = (node: JsonSchema): void => {
    for (const option of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) visit(option)
    const types = node.type === undefined ? [] : [node.type].flat()
    for (const type of types) kinds.add(type === 'integer' ? 'number' : type)
    for (const value of node.enum ?? (node.const === undefined ? [] : [node.const])) {
      kinds.add(value === null ? 'null' : typeof value)
    }
  }
  visit(schema)
  return [...kinds].sort()
}

function jsonLiterals(schema: JsonSchema): string[] | null {
  if (schema.enum) return schema.enum.map(String).sort()
  if (schema.const !== undefined) return [String(schema.const)]
  return null
}

// A union input needs its discriminator before its own keys are checked.
const SWEEP_BASE: Record<string, Record<string, unknown>> = {
  'folderView.getViews': { kind: 'folder', path: 'a' },
  'folderView.getAvailableProperties': { kind: 'folder', path: 'a' },
  'folderView.setView:scope': { kind: 'folder', path: 'a' },
  'folderView.deleteView': { kind: 'folder', path: 'a' },
  'reminders.create': { targetType: 'note', targetId: 'n1', remindAt: '2026-10-01T09:00:00Z' }
}

// Inputs that take any key by design.
const OPEN_RECORDS = new Set(['properties.set:properties'])

describe('desktop API object arguments', () => {
  const params = preloadParams().filter((param) => param.isObject)

  it('are found in the preload declaration', () => {
    expect(params.length).toBeGreaterThan(100)
  })

  it('refuse an unknown key by name in every object argument of every allowlisted operation', () => {
    const accepted: string[] = []
    for (const param of params) {
      const id = `${param.operation}:${param.name}`
      if (OPEN_RECORDS.has(id)) continue
      const operation = param.operation as (typeof AgentMcpDesktopOperations)[number]
      const base = SWEEP_BASE[id] ?? SWEEP_BASE[param.operation] ?? {}
      const input = { ...base, zzSweep: 1 }
      const args: unknown[] = desktopOperationParams(operation).map(() => 'x')
      args[param.index] = param.isArray ? [input] : input
      try {
        assertDesktopApiArgs({ operation, args })
        accepted.push(id)
      } catch (error) {
        if (!String((error as Error).message).includes('zzSweep')) {
          accepted.push(`${id} (${(error as Error).message})`)
        }
      }
    }
    expect(accepted).toEqual([])
  })

  it.each([
    {
      operation: 'folderView.setView',
      args: [
        { kind: 'folder', path: 'a' },
        { name: 'v', filters: { and: ['x'], zzAnd: 1 } }
      ],
      unknown: 'view.filters.zzAnd'
    },
    {
      operation: 'folderView.setView',
      args: [
        { kind: 'folder', path: 'a' },
        { name: 'v', filters: { or: [{ not: 'x', zzNot: 1 }] } }
      ],
      unknown: 'view.filters.or.0.zzNot'
    },
    {
      operation: 'folderView.setConfig',
      args: ['a', { views: [{ name: 'v', filters: { not: { and: ['x'], zzDeep: 1 } } }] }],
      unknown: 'views.0.filters.not.zzDeep'
    },
    {
      operation: 'folderView.setConfig',
      args: ['a', { properties: { status: { hidden: true, zzProp: 1 } } }],
      unknown: 'properties.status.zzProp'
    },
    {
      operation: 'folderView.setConfig',
      args: ['a', { summaries: { count: { type: 'count', zzSum: 1 } } }],
      unknown: 'summaries.count.zzSum'
    },
    {
      operation: 'settings.setKeyboardSettings',
      args: [
        {
          overrides: { 'nav.next': { key: 'k', modifiers: { meta: true, zzMod: 1 }, zzBind: 1 } },
          globalCapture: null
        }
      ],
      unknown: 'overrides.nav.next.zzBind'
    }
  ])(
    'refuses $unknown nested in a record value or a recursive filter',
    ({ operation, args, unknown }) => {
      expect(() =>
        assertDesktopApiArgs({
          operation: operation as (typeof AgentMcpDesktopOperations)[number],
          args
        })
      ).toThrow(unknown)
    }
  )
})

// The responder still reads these older call shapes, which the declaration
// does not list.
const LEGACY_KINDS: Record<string, string[]> = {
  'calendar.getRange:inputOrStart': ['object', 'string'],
  'calendar.listEvents:options': ['object', 'string']
}

describe('desktop API argument schemas', () => {
  const params = preloadParams()

  it('publish, for every parameter, the kind, optionality and literal values the preload declares', () => {
    const mismatches: string[] = []
    for (const param of params) {
      const schema = desktopOperationJsonSchema(param.operation)
      const item = (schema.prefixItems?.[param.index] ?? {}) as JsonSchema
      const id = `${param.operation}:${desktopOperationParams(param.operation)[param.index]}`
      const required = param.index < (schema.minItems ?? 0)
      if (required === param.optional) {
        mismatches.push(`${id}: declared ${param.optional ? 'optional' : 'required'}`)
      }
      const declared = LEGACY_KINDS[id] ?? param.kinds
      if (declared.length > 0 && jsonKinds(item).join() !== declared.join()) {
        mismatches.push(
          `${id}: declared ${declared.join('|')}, schema ${jsonKinds(item).join('|')}`
        )
      }
      if (param.literals && jsonLiterals(item)?.join() !== param.literals.join()) {
        mismatches.push(`${id}: declared ${param.literals.join('|')}, schema ${jsonLiterals(item)}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('cover every parameter of every allowlisted operation', () => {
    const counts = new Map<string, number>()
    for (const param of params) counts.set(param.operation, (counts.get(param.operation) ?? 0) + 1)
    // The responder still takes the older (start, end) string pair.
    counts.set('calendar.getRange', 2)
    const mismatches = AgentMcpDesktopOperations.filter(
      (operation) => (counts.get(operation) ?? 0) !== desktopOperationParams(operation).length
    )
    expect(mismatches).toEqual([])
  })
})
