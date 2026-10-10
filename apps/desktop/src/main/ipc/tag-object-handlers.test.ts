import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { TagSchemaChannels } from '@memry/contracts/ipc-channels'
import { AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import type { FieldFillStatus, FillFieldsResult } from '@memry/contracts/tag-fill-api'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const state = vi.hoisted(() => ({
  agent: {} as { fieldFillDisclosureAccepted?: boolean },
  model: null as unknown,
  note: null as null | {
    title: string
    content: string
    headerTags: string[]
    properties?: Record<string, unknown>
    contentOmitted?: boolean
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<typeof mockIpcMain.handle>[1]) =>
      mockIpcMain.handle(channel, handler),
    removeHandler: (channel: string) => mockIpcMain.removeHandler(channel)
  }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))
vi.mock('../store', () => ({
  store: {
    get: () => state.agent,
    set: (_key: string, value: typeof state.agent) => {
      state.agent = value
    }
  }
}))
vi.mock('../lib/main-i18n', () => ({ getMainI18n: () => ({ language: 'en' }) }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../vault/notes-crud', () => ({ getNoteById: vi.fn(async () => state.note) }))
vi.mock('../ai-inline/ai-llm-service', () => ({ createLanguageModel: () => state.model }))

import { getDatabase, getIndexDatabase, requireDatabase } from '../database'
import { setSetting } from '../settings/settings-store'
import { registerTagObjectHandlers, unregisterTagObjectHandlers } from './tag-object-handlers'

const BODY = 'Met at the Globex offsite. She runs engineering there as CTO.'

function modelReturning(json: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(json) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 }
      },
      warnings: []
    })
  })
}

let data: TestDatabaseResult
let index: TestDatabaseResult
let model: MockLanguageModelV3

const OPENAI = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' } as const

function useSettings(settings: Partial<typeof AI_INLINE_SETTINGS_DEFAULTS>): void {
  setSetting(
    asClientDb(data.db),
    'ai-inline',
    JSON.stringify({ ...AI_INLINE_SETTINGS_DEFAULTS, ...settings })
  )
}

beforeEach(() => {
  resetIpcMocks()
  data = createTestDataDb()
  index = createTestIndexDb()
  ;(getIndexDatabase as Mock).mockReturnValue(index.db)
  ;(getDatabase as Mock).mockReturnValue(data.db)
  ;(requireDatabase as Mock).mockReturnValue(data.db)
  state.agent = {}
  state.note = { title: 'Elif Demir', content: BODY, headerTags: ['person'], properties: {} }
  model = modelReturning({
    proposals: [
      { field: 'Company', value: 'Globex', sourceText: 'Met at the Globex offsite.' },
      { field: 'Role', value: 'CTO', sourceText: 'She runs engineering there as CTO.' }
    ]
  })
  state.model = model

  data.db.run(sql`
    INSERT INTO tag_definitions (name, color, schema) VALUES
      ('person', 'blue', ${JSON.stringify({ t: 1, fields: [{ name: 'Company', relation: { target: 'company' } }, { name: 'Role' }] })}),
      ('company', 'blue', ${JSON.stringify({ t: 1, fields: [{ name: 'Website' }] })})
  `)
  index.db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, content_hash, created_at, modified_at)
    VALUES ('n-globex', 'notes/globex.md', 'Globex', 'markdown', 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
  index.db.run(
    sql`INSERT INTO note_tags (note_id, tag, position, in_header) VALUES ('n-globex', 'company', 0, 1)`
  )
  registerTagObjectHandlers()
})

afterEach(() => {
  unregisterTagObjectHandlers()
  data.close()
  index.close()
})

const status = () => invokeHandler<FieldFillStatus>(TagSchemaChannels.invoke.FILL_STATUS)
const fill = (input: unknown) =>
  invokeHandler<FillFieldsResult>(TagSchemaChannels.invoke.FILL_FIELDS, input)

describe('fill status', () => {
  it('reports the configured model and a first-run disclosure still owed', async () => {
    useSettings(OPENAI)

    expect(await status()).toEqual({
      available: true,
      model: 'gpt-4o',
      local: false,
      disclosureAccepted: false
    })
  })

  it('reports fill unavailable when inline AI is off', async () => {
    useSettings({ enabled: false })

    expect(await status()).toMatchObject({ available: false })
  })

  it('reports the disclosure as accepted once the user accepted it', async () => {
    state.agent = { fieldFillDisclosureAccepted: true }
    useSettings({ provider: 'ollama' })

    expect(await status()).toMatchObject({ disclosureAccepted: true, local: true })
  })
})

describe('fill fields', () => {
  it('does nothing and asks nothing of the model while inline AI is off', async () => {
    useSettings({ enabled: false })

    expect(await fill({ noteId: 'n1' })).toEqual({ kind: 'unavailable' })
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('asks for the disclosure before sending a note, and sends nothing', async () => {
    useSettings(OPENAI)

    expect(await fill({ noteId: 'n1' })).toEqual({
      kind: 'disclosure-required',
      model: 'gpt-4o',
      local: false
    })
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(state.agent.fieldFillDisclosureAccepted).toBeUndefined()
  })

  it('remembers an accepted disclosure and proposes values, matching a relation to the vault note', async () => {
    useSettings(OPENAI)

    const result = await fill({ noteId: 'n1', acceptDisclosure: true })

    expect(result).toEqual({
      kind: 'proposals',
      proposals: [
        {
          field: 'Company',
          value: ['memry://note/n-globex'],
          display: 'Globex',
          sourceText: 'Met at the Globex offsite.'
        },
        {
          field: 'Role',
          value: 'CTO',
          display: 'CTO',
          sourceText: 'She runs engineering there as CTO.'
        }
      ]
    })
    expect(state.agent.fieldFillDisclosureAccepted).toBe(true)
    expect(await status()).toMatchObject({ disclosureAccepted: true })
  })

  it('skips fields the note already fills and sends the note body to the model', async () => {
    useSettings(OPENAI)
    state.agent = { fieldFillDisclosureAccepted: true }
    state.note = { ...state.note!, properties: { Role: 'Founder' } }

    const result = await fill({ noteId: 'n1' })

    expect(result).toMatchObject({ kind: 'proposals' })
    expect(result.kind === 'proposals' && result.proposals.map((p) => p.field)).toEqual(['Company'])
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain('Met at the Globex offsite.')
  })

  it('proposes nothing for a note that is missing or whose content is omitted', async () => {
    useSettings(OPENAI)
    state.agent = { fieldFillDisclosureAccepted: true }

    state.note = null
    expect(await fill({ noteId: 'gone' })).toEqual({ kind: 'proposals', proposals: [] })

    state.note = { title: 'Locked', content: '', headerTags: ['person'], contentOmitted: true }
    expect(await fill({ noteId: 'locked' })).toEqual({ kind: 'proposals', proposals: [] })
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('returns a failure message instead of throwing when the model errors', async () => {
    useSettings(OPENAI)
    state.agent = { fieldFillDisclosureAccepted: true }
    state.model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('model offline')
      }
    })

    expect(await fill({ noteId: 'n1' })).toEqual({ kind: 'failed', message: 'model offline' })
  })

  it('rejects a request without a note id', async () => {
    await expect(fill({ noteId: '' })).rejects.toThrow(/Validation failed/)
  })
})
