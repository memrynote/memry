import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  AGENT_DESKTOP_OPERATION_PARAMS,
  desktopArgsItemSchemas,
  desktopOperationArgsSchema,
  desktopOperationJsonSchema,
  desktopOperationParamNames
} from './agent-desktop-api-args'
import { AgentMcpDesktopOperations } from './agent-mcp-channels'

describe('agent desktop API argument schemas', () => {
  it('cover every allowlisted operation and nothing else', () => {
    expect(Object.keys(AGENT_DESKTOP_OPERATION_PARAMS).sort()).toEqual(
      [...AgentMcpDesktopOperations].sort()
    )
  })

  it('publish a JSON Schema for the arguments array of every operation', () => {
    for (const operation of AgentMcpDesktopOperations) {
      const params = desktopOperationParamNames(operation)
      const schema = desktopOperationJsonSchema(operation)
      expect(schema.type, operation).toBe('array')
      expect(desktopArgsItemSchemas(schema), operation).toHaveLength(params.length)
      expect(schema.maxItems, operation).toBe(params.length)
      expect(schema.minItems, operation).toBeLessThanOrEqual(params.length)
      expect(JSON.stringify(schema).length, operation).toBeLessThan(64 * 1024)
    }
  })

  it('publish a schema that compiles under a strict draft 2020-12 validator for every operation', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    addFormats(ajv)
    const invalid: string[] = []
    for (const operation of AgentMcpDesktopOperations) {
      const schema = desktopOperationJsonSchema(operation)
      if (!ajv.validateSchema(schema)) {
        invalid.push(`${operation}: ${ajv.errorsText(ajv.errors)}`)
        continue
      }
      try {
        ajv.compile(schema)
      } catch (error) {
        invalid.push(`${operation}: ${(error as Error).message}`)
      }
    }
    expect(invalid).toEqual([])
  })

  it('publish optional trailing arguments as calls a validator accepts or refuses like the bridge', () => {
    const ajv = new Ajv2020({ strict: true })
    addFormats(ajv)
    const calls: Array<[(typeof AgentMcpDesktopOperations)[number], unknown[]]> = [
      ['notes.list', []],
      ['notes.list', [null]],
      ['notes.list', [{ folder: 'a' }]],
      ['notes.list', [{ folder: 'a' }, 1]],
      ['notes.list', ['a']],
      ['inbox.linkToNote', ['i1']],
      ['inbox.linkToNote', ['i1', 'n1']],
      ['inbox.linkToNote', ['i1', 'n1', ['t']]],
      ['inbox.linkToNote', ['i1', 'n1', 5]],
      ['folderView.setView', [{ kind: 'folder', path: 'a' }, { name: 'v' }, 'old']],
      ['folderView.setView', [{ kind: 'folder', path: 'a' }]],
      ['notes.get', ['n1']],
      ['notes.get', ['n1', 'n2']],
      ['notes.getTags', []],
      ['notes.getTags', ['x']]
    ]
    const disagreements = calls.filter(
      ([operation, args]) =>
        ajv.validate(desktopOperationJsonSchema(operation), args) !==
        desktopOperationArgsSchema(operation).safeParse(args).success
    )
    expect(disagreements).toEqual([])
  })

  it('say an operation without parameters takes no arguments', () => {
    const schema = desktopOperationJsonSchema('notes.getTags')
    expect(schema).not.toHaveProperty('prefixItems')
    expect(schema).toMatchObject({ type: 'array', minItems: 0, maxItems: 0 })
  })

  it('count only the leading required arguments as required', () => {
    expect(desktopOperationJsonSchema('notes.list').minItems).toBe(0)
    expect(desktopOperationJsonSchema('notes.importFiles').minItems).toBe(1)
    expect(desktopOperationJsonSchema('folderView.setView').minItems).toBe(2)
    expect(desktopOperationArgsSchema('notes.list').safeParse([]).success).toBe(true)
    expect(desktopOperationArgsSchema('notes.importFiles').safeParse([['/a.md']]).success).toBe(
      true
    )
    expect(desktopOperationArgsSchema('notes.get').safeParse([]).success).toBe(false)
  })

  it('accept null for an optional argument the preload reads as left out, and publish it', () => {
    expect(desktopOperationArgsSchema('notes.list').safeParse([null]).success).toBe(true)
    expect(desktopOperationArgsSchema('tasks.getUpcoming').safeParse([null]).success).toBe(true)
    expect(desktopOperationArgsSchema('canvas.create').safeParse([null]).success).toBe(true)
    expect(
      desktopOperationArgsSchema('inbox.linkToNote').safeParse(['i1', 'n1', null]).success
    ).toBe(true)
    expect(desktopOperationArgsSchema('reminders.getUpcoming').safeParse([null]).success).toBe(
      false
    )
    expect(
      desktopArgsItemSchemas(desktopOperationJsonSchema('tasks.getUpcoming'))[0]
    ).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }])
    })
  })

  it('say which property types each property definition call accepts', () => {
    const ensure = desktopOperationJsonSchema('notes.ensurePropertyDefinition')
    expect(ensure.prefixItems?.[1]).toMatchObject({ enum: ['status', 'select', 'multiselect'] })
    const create = desktopOperationJsonSchema('notes.createPropertyDefinition')
    expect(create.prefixItems?.[0]).toMatchObject({
      properties: {
        type: {
          enum: ['text', 'number', 'checkbox', 'date', 'url', 'status', 'select', 'multiselect']
        }
      }
    })
  })

  it('refuse an unknown key at any depth and advertise it', () => {
    const define = desktopOperationArgsSchema('notes.createPropertyDefinition')
    expect(define.safeParse([{ name: 'mood', type: 'select', optionz: [] }]).success).toBe(false)
    expect(
      define.safeParse([{ name: 'mood', type: 'select', options: [{ value: 'a', color: 'b' }] }])
        .success
    ).toBe(true)
    expect(
      desktopOperationJsonSchema('notes.createPropertyDefinition').prefixItems?.[0]
    ).toMatchObject({ additionalProperties: false })
  })

  it('keep an open record open', () => {
    expect(
      desktopOperationArgsSchema('properties.set').safeParse(['n1', { anyName: 1 }]).success
    ).toBe(true)
  })

  it('accept the older calendar call shapes the responder still reads', () => {
    expect(
      desktopOperationArgsSchema('calendar.getRange').safeParse(['2026-10-01', '2026-10-02'])
        .success
    ).toBe(true)
    expect(
      desktopOperationArgsSchema('calendar.getRange').safeParse([
        { startAt: '2026-10-01', endAt: '2026-10-02' }
      ]).success
    ).toBe(true)
    expect(
      desktopOperationArgsSchema('calendar.listEvents').safeParse(['{"includeArchived":true}'])
        .success
    ).toBe(true)
  })

  it('accept a partial settings update', () => {
    expect(
      desktopOperationArgsSchema('settings.setEditorSettings').safeParse([{ spellCheck: false }])
        .success
    ).toBe(true)
    expect(
      desktopOperationArgsSchema('settings.setEditorSettings').safeParse([{ spellCheck: 'no' }])
        .success
    ).toBe(false)
  })
})
