import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AgentMcpDesktopOperations } from '@memry/contracts/agent-mcp-channels'

import { DESKTOP_INPUT_SCHEMAS } from '../desktop-api-inputs'
import { assertDesktopApiArgs, desktopOperationParams } from '../desktop-api-params'

const desktopRoot = path.resolve(__dirname, '../../../../../..')

interface ObjectParam {
  operation: string
  name: string
  index: number
  isArray: boolean
}

// Every argument of an allowlisted operation whose preload type is an object
// (or an array of objects), read from the `window.api` declaration.
function preloadObjectParams(): ObjectParam[] {
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

  const params: ObjectParam[] = []
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
      if (!isObject(type)) return
      params.push({
        operation,
        name: symbol.name,
        index,
        isArray: checker.isArrayType(checker.getNonNullableType(type))
      })
    })
  }
  return params
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
  const params = preloadObjectParams()

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

  it('key every input schema by the name of an object parameter', () => {
    const objectParams = new Set(
      params.map((param) => {
        const operation = param.operation as (typeof AgentMcpDesktopOperations)[number]
        return `${operation}:${desktopOperationParams(operation)[param.index]}`
      })
    )
    const stray = Object.entries(DESKTOP_INPUT_SCHEMAS).flatMap(([operation, inputs]) =>
      Object.keys(inputs ?? {})
        .map((name) => `${operation}:${name}`)
        .filter((id) => !objectParams.has(id))
    )
    expect(stray).toEqual([])
  })
})
