import { describe, expect, it } from 'vitest'
import { rankCommands, type RankableCommand } from './rank-commands'

const cmd = (id: string, label: string, extra: Partial<RankableCommand> = {}): RankableCommand => ({
  id,
  label,
  ...extra
})

const LIST = [
  cmd('sidebar', 'Toggle Sidebar'),
  cmd('day', 'Toggle Day Panel'),
  cmd('project', 'New Project'),
  cmd('task', 'New Task'),
  cmd('settings', 'Settings: Appearance'),
  cmd('tabs', 'Split Right')
]

const ids = (list: readonly RankableCommand[]): string[] => list.map((c) => c.id)

describe('rankCommands', () => {
  it('ranks a label prefix above a word prefix above a subsequence', () => {
    const list = [
      cmd('subsequence', 'Close All Tabs'),
      cmd('word', 'Toggle Task Panel'),
      cmd('prefix', 'Task Inbox')
    ]
    expect(ids(rankCommands(list, 'tas', []))).toEqual(['prefix', 'word', 'subsequence'])
    // "tab" starts a word of "Close All Tabs" but only threads through "Task Inbox".
    expect(ids(rankCommands(list, 'tab', []))).toEqual(['subsequence', 'prefix'])
    expect(ids(rankCommands(list, 'cat', []))).toEqual(['subsequence'])
  })

  it('finds a command by the start of any of its words', () => {
    expect(ids(rankCommands(LIST, 'side', []))).toEqual(['sidebar'])
    expect(ids(rankCommands(LIST, 'proj', []))).toEqual(['project'])
  })

  it('matches every typed word against some word of the label', () => {
    expect(ids(rankCommands(LIST, 'new proj', []))).toEqual(['project'])
    expect(ids(rankCommands(LIST, 'proj new', []))).toEqual(['project'])
  })

  it('matches a keyword like the label', () => {
    const list = [cmd('a', 'Light', { keywords: ['Theme'] }), cmd('b', 'Split Right')]
    expect(ids(rankCommands(list, 'theme', []))).toEqual(['a'])
  })

  it('ignores case, accents and punctuation', () => {
    const list = [cmd('a', 'Export to PDF…'), cmd('b', 'Café')]
    expect(ids(rankCommands(list, 'EXPORT', []))).toEqual(['a'])
    expect(ids(rankCommands(list, 'cafe', []))).toEqual(['b'])
    expect(ids(rankCommands(list, 'settings:', [])).length).toBe(0)
  })

  it('matches a run of letters that appear in order', () => {
    expect(ids(rankCommands(LIST, 'tglsb', []))).toEqual(['sidebar'])
    expect(ids(rankCommands(LIST, 'zzz', []))).toEqual([])
  })

  it('lifts a recent command above an equal match, most recent first', () => {
    expect(ids(rankCommands(LIST, 'tog', []))).toEqual(['sidebar', 'day'])
    expect(ids(rankCommands(LIST, 'tog', ['day']))).toEqual(['day', 'sidebar'])
    expect(ids(rankCommands(LIST, 'new', ['task', 'project']))).toEqual(['task', 'project'])
  })

  it('does not let a recent subsequence outrank a better match', () => {
    const list = [cmd('weak', 'Close All Tabs'), cmd('strong', 'Tab Menu')]
    expect(ids(rankCommands(list, 'tab', ['weak']))[0]).toBe('strong')
  })

  it('does not list a recent command that does not match', () => {
    expect(ids(rankCommands(LIST, 'side', ['task']))).toEqual(['sidebar'])
  })

  it('puts the active tab first among equal matches', () => {
    const list = [cmd('app', 'Find Files'), cmd('note', 'Find', { contextual: true })]
    expect(ids(rankCommands(list, 'find', []))).toEqual(['note', 'app'])
  })

  it('keeps the given order for equal matches, and for an empty query', () => {
    expect(ids(rankCommands(LIST, '', []))).toEqual(ids(LIST))
    expect(ids(rankCommands(LIST, '  ', ['tabs']))).toEqual(['tabs', ...ids(LIST).slice(0, 5)])
  })
})
