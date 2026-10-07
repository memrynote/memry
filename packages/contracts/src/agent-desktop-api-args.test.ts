import { describe, expect, it } from 'vitest'

import {
  AGENT_DESKTOP_OPERATION_PARAMS,
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
      expect(schema.prefixItems ?? [], operation).toHaveLength(params.length)
      expect(schema.maxItems, operation).toBe(params.length)
      expect(schema.minItems, operation).toBeLessThanOrEqual(params.length)
      expect(JSON.stringify(schema).length, operation).toBeLessThan(64 * 1024)
    }
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
