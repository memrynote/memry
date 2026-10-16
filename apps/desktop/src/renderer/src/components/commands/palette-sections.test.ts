import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandId, type CommandMeta } from '@memry/contracts/commands'
import { RESOURCES } from '@memry/i18n/locales'
import { buildSections, type PaletteCommand } from './palette-sections'

const cmd = (
  id: CommandId,
  group: PaletteCommand['group'],
  extra: Partial<PaletteCommand> = {}
): PaletteCommand => ({ id, label: id, group, context: 'app', ...extra })

const LIST: PaletteCommand[] = [
  cmd('go.inbox', 'navigation'),
  cmd('create.task', 'create'),
  cmd('tabs.pinTab', 'tabs'),
  cmd('settings.openGeneral', 'settings'),
  cmd('note.find', 'note', { context: 'note', contextual: true }),
  cmd('note.exportPdf', 'note', { context: 'note', contextual: true })
]

const shape = (sections: ReturnType<typeof buildSections>): string[][] =>
  sections.map((s) => [s.kind, ...s.commands.map((c) => c.id)])

describe('palette headings', () => {
  const { groups, contexts } = RESOURCES.en.common.commandsPalette
  const metas = Object.values(COMMANDS) as CommandMeta[]

  it('names every group a command sits in', () => {
    for (const group of new Set(metas.map((meta) => meta.group))) {
      expect(groups[group], group).toEqual(expect.any(String))
    }
  })

  it('names every tab context a command acts on, and a tag tab', () => {
    const tabContexts = new Set(metas.map((meta) => meta.context).filter((c) => c !== 'app'))
    for (const context of [...tabContexts, 'tag'] as const) {
      expect(contexts[context as keyof typeof contexts], context).toEqual(expect.any(String))
    }
  })
})

describe('buildSections', () => {
  it('lists the active tab first, then recents, then the rest by group', () => {
    expect(shape(buildSections(LIST, '', ['tabs.pinTab']))).toEqual([
      ['context', 'note.find', 'note.exportPdf'],
      ['recent', 'tabs.pinTab'],
      ['group', 'go.inbox'],
      ['group', 'create.task'],
      ['group', 'settings.openGeneral']
    ])
  })

  it('shows each command once, even a recent one that is also contextual', () => {
    const sections = buildSections(LIST, '', ['note.find', 'go.inbox'])
    const all = sections.flatMap((s) => s.commands.map((c) => c.id))
    expect(new Set(all).size).toBe(all.length)
    expect(shape(sections)[1]).toEqual(['recent', 'go.inbox'])
  })

  it('names the context of the active tab', () => {
    expect(buildSections(LIST, '', [])[0]).toMatchObject({ kind: 'context', context: 'note' })
  })

  it('calls a tag tab a tag, though it runs the folder view commands', () => {
    const folder = [cmd('folder.newNote', 'folder', { context: 'folder', contextual: true })]
    expect(buildSections(folder, '', [], 'folder')[0]).toMatchObject({ context: 'folder' })
    expect(buildSections(folder, '', [], 'tag')[0]).toMatchObject({ context: 'tag' })
  })

  it('skips a recent that is not available now', () => {
    expect(shape(buildSections(LIST.slice(0, 2), '', ['tabs.pinTab']))).toEqual([
      ['group', 'go.inbox'],
      ['group', 'create.task']
    ])
  })

  it('answers a query with one ranked list and no headings', () => {
    expect(shape(buildSections(LIST, 'go.in', []))).toEqual([['results', 'go.inbox']])
    expect(buildSections(LIST, 'zzzz', [])).toEqual([])
  })
})
