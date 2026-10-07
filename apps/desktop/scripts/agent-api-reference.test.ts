import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { AgentMcpDesktopOperations } from '@memry/contracts/agent-mcp-channels'
import { desktopOperationArgsSchema } from '@memry/contracts/agent-desktop-api-args'

import {
  READ_TOOL_NAMES,
  TOOL_SCHEMAS,
  WRITE_TOOL_NAMES
} from '../src/main/agent/mcp/tools/schemas'
import {
  REFERENCE_PATHS,
  committedAppVersion,
  nextAppVersion,
  readExamples,
  renderReference
} from './agent-api-reference'

const FIX = 'Run: pnpm --filter @memry/desktop agent-api:generate'

describe('agent API reference', () => {
  const examples = readExamples()
  const version = committedAppVersion()

  it('matches the tool schemas and operations on this commit', () => {
    expect(version, 'the committed schema file names its app version').toBeTruthy()
    const { page, schema } = renderReference(version as string, examples)
    expect(readFileSync(REFERENCE_PATHS.page, 'utf8') === page, FIX).toBe(true)
    expect(readFileSync(REFERENCE_PATHS.schema, 'utf8') === schema, FIX).toBe(true)
  })

  it('has an example for every tool and every desktop operation', () => {
    const tools = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
    expect(tools.filter((name) => !examples.tools[name])).toEqual([])
    expect(AgentMcpDesktopOperations.filter((op) => !examples.operations[op])).toEqual([])
  })

  it('records example calls the current schemas accept', () => {
    const rejected: string[] = []
    for (const [name, example] of Object.entries(examples.tools)) {
      const schema = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS]
      if (!schema) rejected.push(`${name}: no such tool`)
      else if (!example.is_error && !schema.input.safeParse(example.arguments).success)
        rejected.push(name)
    }
    for (const [operation, example] of Object.entries(examples.operations)) {
      if (!(AgentMcpDesktopOperations as readonly string[]).includes(operation)) {
        rejected.push(`${operation}: no such operation`)
        continue
      }
      const args = desktopOperationArgsSchema(
        operation as (typeof AgentMcpDesktopOperations)[number]
      )
      if (!example.is_error && !args.safeParse(example.args).success) rejected.push(operation)
    }
    expect(rejected).toEqual([])
  })

  it('marks a regeneration between releases as +main', () => {
    expect(nextAppVersion(undefined, '2026.928.1')).toBe('2026.928.1+main')
    expect(nextAppVersion(undefined, '2026.928.1+main')).toBe('2026.928.1+main')
    expect(nextAppVersion('2026.1010.1', '2026.928.1+main')).toBe('2026.1010.1')
  })
})
