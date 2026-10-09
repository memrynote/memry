import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import { AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { ObjectMatch } from '@memry/contracts/tag-objects-api'
import { fillFields, parseLocaleNumber, type FillFieldsDeps, type FillNote } from './fill-fields'

function field(name: string, type: ResolvedField['type'], target?: string): ResolvedField {
  return {
    name,
    type,
    relation: target ? { target, many: false, inverse: null } : null,
    definedBy: 'person'
  }
}

const personFields = [
  field('Company', 'relation', 'company'),
  field('Role', 'text'),
  field('Email', 'text'),
  field('Phone', 'text')
]

const person: ResolvedTag = {
  name: 'person',
  key: 'person',
  color: 'sky',
  icon: null,
  editable: true,
  ownFields: personFields,
  inherited: [],
  effectiveFields: personFields,
  hasFields: true,
  extends: null,
  ancestors: [],
  template: null,
  preset: 'person',
  ownPreset: 'person'
}

const BODY =
  'Met at the Globex offsite. She runs engineering there as CTO and wants a field-team pilot in June. Reach her at elif@globex.io.'

const globex: ObjectMatch = {
  noteId: 'n-globex',
  title: 'Globex',
  tag: 'company',
  groupTag: 'company',
  viaTag: null,
  subtitle: [],
  modified: '2026-01-01'
}

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

function setup(overrides: Partial<FillFieldsDeps> = {}, note?: Partial<FillNote>) {
  const stored: FillNote = {
    title: 'Elif Demir',
    content: BODY,
    headerTags: ['person'],
    properties: { Phone: '' },
    ...note
  }
  const snapshot = structuredClone(stored)
  const model = modelReturning({
    proposals: [
      { field: 'Company', value: 'Globex', sourceText: 'Met at the Globex offsite.' },
      { field: 'role', value: 'CTO', sourceText: 'She runs engineering there as CTO' },
      { field: 'Email', value: 'elif@globex.io', sourceText: 'not in the note' },
      { field: 'Unknown', value: 'x', sourceText: '' }
    ]
  })
  const deps: FillFieldsDeps = {
    settings: { ...AI_INLINE_SETTINGS_DEFAULTS, enabled: true },
    disclosureAccepted: true,
    acceptDisclosure: vi.fn(),
    getNote: vi.fn(async () => stored),
    resolved: new Map([['person', person]]),
    locale: 'en',
    searchObjects: vi.fn(() => [globex]),
    model,
    ...overrides
  }
  return { deps, model, stored, snapshot }
}

describe('fillFields', () => {
  it('proposes values for empty fields only, in panel order, and writes nothing', async () => {
    const { deps, model, stored, snapshot } = setup({}, { properties: { Phone: '' } })

    const result = await fillFields(deps, { noteId: 'n1' })

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
          sourceText: 'She runs engineering there as CTO'
        },
        { field: 'Email', value: 'elif@globex.io', display: 'elif@globex.io', sourceText: '' }
      ]
    })
    expect(stored).toEqual(snapshot)
    expect(deps.searchObjects).toHaveBeenCalledWith('company')
    // Only this note is sent.
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt)
    expect(prompt).toContain('elif@globex.io')
    expect(prompt).toContain('Globex')
  })

  it('never sends the titles of other notes to the model', async () => {
    const other: ObjectMatch = { ...globex, noteId: 'n-initech', title: 'Initech Holdings' }
    const { deps, model } = setup({ searchObjects: vi.fn(() => [globex, other]) })

    await fillFields(deps, { noteId: 'n1' })

    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).not.toContain('Initech')
  })

  it('refuses a date that is not a real day', async () => {
    const dated = { ...person, effectiveFields: [field('Met', 'date')] }
    const { deps } = setup({
      resolved: new Map([['person', dated]]),
      model: modelReturning({ proposals: [{ field: 'Met', value: '2026-02-30', sourceText: '' }] })
    })

    expect(await fillFields(deps, { noteId: 'n1' })).toEqual({ kind: 'proposals', proposals: [] })
  })

  it('skips a filled field and offers to create an unknown relation target', async () => {
    const { deps } = setup({ searchObjects: vi.fn(() => []) }, { properties: { Role: 'Founder' } })

    const result = await fillFields(deps, { noteId: 'n1' })

    if (result.kind !== 'proposals') throw new Error(result.kind)
    expect(result.proposals.map((p) => p.field)).toEqual(['Company', 'Email'])
    expect(result.proposals[0]).toMatchObject({
      value: null,
      create: { title: 'Globex', tag: 'company' }
    })
  })

  it('is unavailable without a configured provider and never calls the model', async () => {
    const { deps, model } = setup({
      settings: { ...AI_INLINE_SETTINGS_DEFAULTS, provider: 'openai', apiKey: '' }
    })

    expect(await fillFields(deps, { noteId: 'n1' })).toEqual({ kind: 'unavailable' })
    expect(model.doGenerateCalls).toHaveLength(0)

    const off = setup({ settings: { ...AI_INLINE_SETTINGS_DEFAULTS, enabled: false } })
    expect(await fillFields(off.deps, { noteId: 'n1' })).toEqual({ kind: 'unavailable' })
  })

  it('asks for the disclosure first, then records it once accepted', async () => {
    const { deps, model } = setup({ disclosureAccepted: false })

    expect(await fillFields(deps, { noteId: 'n1' })).toEqual({
      kind: 'disclosure-required',
      model: 'llama3.2',
      local: true
    })
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(deps.getNote).not.toHaveBeenCalled()

    const accepted = await fillFields(deps, { noteId: 'n1', acceptDisclosure: true })
    expect(deps.acceptDisclosure).toHaveBeenCalledTimes(1)
    expect(accepted.kind).toBe('proposals')
  })

  it('does not call the model for a note with no empty fields', async () => {
    const { deps, model } = setup(
      {},
      { properties: { Company: ['memry://note/x'], Role: 'a', Email: 'b', Phone: 'c' } }
    )

    expect(await fillFields(deps, { noteId: 'n1' })).toEqual({ kind: 'proposals', proposals: [] })
    expect(model.doGenerateCalls).toHaveLength(0)
  })
})

describe('parseLocaleNumber', () => {
  it('reads a number the way the locale writes it', () => {
    expect(parseLocaleNumber('1,500', 'en')).toBe(1500)
    expect(parseLocaleNumber('1,234.5', 'en')).toBe(1234.5)
    expect(parseLocaleNumber('1.500', 'tr')).toBe(1500)
    expect(parseLocaleNumber('1,5', 'tr')).toBe(1.5)
    expect(parseLocaleNumber('1.5', 'tr')).toBe(1.5)
    expect(parseLocaleNumber('-42', 'en')).toBe(-42)
  })

  it('refuses a form the locale does not decide instead of reading 1,5 as 15', () => {
    expect(parseLocaleNumber('1,5', 'en')).toBeNull()
    expect(parseLocaleNumber('12,34,5', 'en')).toBeNull()
    expect(parseLocaleNumber('about 3', 'en')).toBeNull()
  })
})
