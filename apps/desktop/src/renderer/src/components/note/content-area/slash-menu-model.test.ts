import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SLASH_MENU_RECENTS_KEY,
  buildSlashMenuItems,
  readSlashMenuRecents,
  recordSlashMenuRecent,
  withSecondaryActions,
  type SlashMenuGroupLabels,
  type SlashMenuItem
} from './slash-menu-model'

const labels: SlashMenuGroupLabels = {
  recent: 'Recent',
  bestMatch: 'Best match',
  blocks: 'Blocks',
  headings: 'More headings',
  insert: 'Insert',
  media: 'Media',
  ai: 'AI',
  templates: 'Templates'
}

const item = (id: string, title: string, aliases: string[] = []): SlashMenuItem => ({
  id,
  title,
  aliases,
  group: 'upstream group',
  onItemClick: vi.fn()
})

// Deliberately out of catalog order, with upstream group names.
const all = (): SlashMenuItem[] => [
  item('image', 'Image', ['photo']),
  item('heading_4', 'Heading 4', ['h4']),
  item('check_list', 'Check List', ['todo', 'checkbox']),
  item('heading', 'Heading 1', ['h1']),
  item('ai', 'Ask AI'),
  item('date', 'Today', ['date', 'remind']),
  item('task', 'Task', ['task', 'todo']),
  item('template:t1', "Today's plan"),
  item('paragraph', 'Paragraph', ['p'])
]

const shape = (items: SlashMenuItem[]) => items.map((i) => `${i.group}:${i.id}`)

describe('buildSlashMenuItems', () => {
  it('lists every row at rest in catalog order, including the long tail', () => {
    const result = buildSlashMenuItems({ items: all(), query: '', recentIds: [], labels })

    expect(shape(result)).toEqual([
      'Blocks:paragraph',
      'Blocks:heading',
      'Blocks:check_list',
      'More headings:heading_4',
      'Insert:date',
      'Insert:task',
      'Media:image',
      'AI:ai',
      'Templates:template:t1'
    ])
  })

  it('adds the markdown trigger as the row hint', () => {
    const result = buildSlashMenuItems({ items: all(), query: '', recentIds: [], labels })
    const hints = Object.fromEntries(result.map((i) => [i.id, i.hint]))

    expect(hints.heading).toBe('#')
    expect(hints.heading_4).toBe('####')
    expect(hints.check_list).toBe('[]')
    expect(hints.date).toBe('@')
    expect(hints.image).toBeUndefined()
  })

  it('puts recents first at rest and skips ids no longer offered', () => {
    const result = buildSlashMenuItems({
      items: all(),
      query: '',
      recentIds: ['task', 'whiteboard', 'heading'],
      labels
    })

    expect(shape(result).slice(0, 3)).toEqual(['Recent:task', 'Recent:heading', 'Blocks:paragraph'])
    // The recent copy does not remove the row from its own group.
    expect(result.filter((i) => i.id === 'task')).toHaveLength(2)
  })

  it('ignores recents while filtering', () => {
    const result = buildSlashMenuItems({ items: all(), query: 'h', recentIds: ['task'], labels })
    expect(result.some((i) => i.group === 'Recent')).toBe(false)
  })

  it('lifts the best match to the top and keeps the rest in catalog order', () => {
    const result = buildSlashMenuItems({ items: all(), query: 'tod', recentIds: [], labels })

    // "Today" matches its title at the start; Check List and Task only by alias.
    expect(shape(result)).toEqual([
      'Best match:date',
      'Blocks:check_list',
      'Insert:task',
      'Templates:template:t1'
    ])
    expect(result[0].match).toEqual({ start: 0, end: 3 })
    expect(result[1].matchedAlias).toBe('todo')
    expect(result[1].match).toBeUndefined()
  })

  it('ranks a title match over an alias match', () => {
    const result = buildSlashMenuItems({ items: all(), query: 'task', recentIds: [], labels })
    expect(result[0].id).toBe('task')
    expect(result[0].matchedAlias).toBeUndefined()
  })

  it('keeps the best match in its own group when it is already first', () => {
    const result = buildSlashMenuItems({ items: all(), query: 'head', recentIds: [], labels })
    expect(shape(result)).toEqual(['Blocks:heading', 'More headings:heading_4'])
  })

  it('returns nothing when nothing matches, so BlockNote can close the menu', () => {
    expect(buildSlashMenuItems({ items: all(), query: 'zzz', recentIds: [], labels })).toEqual([])
  })

  it('keeps an uncatalogued row, between Media and AI, under its own group', () => {
    const result = buildSlashMenuItems({
      items: [...all(), item('new_upstream_block', 'Shiny')],
      query: '',
      recentIds: [],
      labels
    })
    expect(shape(result)).toContain('upstream group:new_upstream_block')
    const ids = result.map((i) => i.id)
    expect(ids.indexOf('new_upstream_block')).toBe(ids.indexOf('image') + 1)
  })
})

describe('withSecondaryActions', () => {
  it('borrows the target row action when the target is present', () => {
    const items = all()
    const result = withSecondaryActions(items, [
      { from: 'check_list', to: 'task', label: 'As linked task' },
      { from: 'heading', to: 'toggle_heading', label: 'As toggle' }
    ])
    const checkList = result.find((i) => i.id === 'check_list')
    const task = items.find((i) => i.id === 'task')

    expect(checkList?.secondary?.label).toBe('As linked task')
    expect(checkList?.secondary?.onItemClick).toBe(task?.onItemClick)
    // No toggle_heading row in the list, so Heading 1 gets no shortcut.
    expect(result.find((i) => i.id === 'heading')?.secondary).toBeUndefined()
  })
})

describe('slash menu recents', () => {
  afterEach(() => localStorage.clear())

  it('keeps the three most recent ids, newest first, without duplicates', () => {
    for (const id of ['a', 'b', 'c', 'a', 'd']) recordSlashMenuRecent(id)
    expect(readSlashMenuRecents()).toEqual(['d', 'a', 'c'])
  })

  it('does not record templates', () => {
    recordSlashMenuRecent('template:abc')
    expect(readSlashMenuRecents()).toEqual([])
  })

  it('tolerates malformed stored data', () => {
    localStorage.setItem(SLASH_MENU_RECENTS_KEY, '{not json')
    expect(readSlashMenuRecents()).toEqual([])
    localStorage.setItem(SLASH_MENU_RECENTS_KEY, JSON.stringify({ a: 1 }))
    expect(readSlashMenuRecents()).toEqual([])
    localStorage.setItem(SLASH_MENU_RECENTS_KEY, JSON.stringify(['x', 3, null, 'y']))
    expect(readSlashMenuRecents()).toEqual(['x', 'y'])
  })
})
