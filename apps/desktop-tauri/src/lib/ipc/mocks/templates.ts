import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockTemplate {
  id: string
  name: string
  body: string
  frontmatter: Record<string, unknown>
  category: string
  createdAt: number
  updatedAt: number
}

const fixtures: Array<Omit<MockTemplate, 'id'>> = [
  {
    name: 'Daily note',
    body: '## Today\n\n- [ ] \n\n## Notes\n',
    frontmatter: { category: 'daily' },
    category: 'daily',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(1)
  },
  {
    name: 'Meeting notes',
    body: '# {{project}} meeting\n\n**Attendees:**\n\n**Agenda:**\n\n**Actions:**\n',
    frontmatter: { category: 'meeting' },
    category: 'meeting',
    createdAt: mockTimestamp(28),
    updatedAt: mockTimestamp(1)
  },
  {
    name: 'Book highlights',
    body: '# Book: \n\n## Highlights\n\n## Summary\n',
    frontmatter: { category: 'reading' },
    category: 'reading',
    createdAt: mockTimestamp(25),
    updatedAt: mockTimestamp(2)
  },
  {
    name: 'Project kickoff',
    body: '# {{project}}\n\n## Goals\n\n## Scope\n\n## Timeline\n',
    frontmatter: { category: 'project' },
    category: 'project',
    createdAt: mockTimestamp(20),
    updatedAt: mockTimestamp(2)
  },
  {
    name: 'Weekly review',
    body: '## Wins\n\n## Challenges\n\n## Lessons — öğrendiklerim\n',
    frontmatter: { category: 'review' },
    category: 'review',
    createdAt: mockTimestamp(14),
    updatedAt: mockTimestamp(1)
  },
  {
    name: 'Bug report',
    body: '## Steps to reproduce\n\n## Expected\n\n## Actual\n\n## Environment\n',
    frontmatter: { category: 'bug' },
    category: 'bug',
    createdAt: mockTimestamp(7),
    updatedAt: mockTimestamp(0)
  }
]

const templates: MockTemplate[] = fixtures.map((f, i) => ({
  id: `template-${i + 1}`,
  ...f
}))

function applyVariables(body: string, variables: Record<string, unknown>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(variables[key] ?? ''))
}

export const templatesRoutes: MockRouteMap = {
  // Contract: TemplateListResponse = { templates: Template[] }
  templates_list: async () => ({ templates }),
  templates_get: async (args) => {
    const { id } = args as { id: string }
    const tpl = templates.find((t) => t.id === id)
    if (!tpl) throw new Error(`Template ${id} not found`)
    return tpl
  },
  templates_create: async (args) => {
    const input = args as Partial<MockTemplate> & { name: string; body: string }
    const now = Date.now()
    const tpl: MockTemplate = {
      id: mockId('template'),
      name: input.name,
      body: input.body,
      frontmatter: input.frontmatter ?? {},
      category: input.category ?? 'general',
      createdAt: now,
      updatedAt: now
    }
    templates.push(tpl)
    return tpl
  },
  templates_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockTemplate>
    const tpl = templates.find((t) => t.id === id)
    if (!tpl) throw new Error(`Template ${id} not found`)
    Object.assign(tpl, changes, { updatedAt: Date.now() })
    return tpl
  },
  templates_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = templates.findIndex((t) => t.id === id)
    if (idx >= 0) templates.splice(idx, 1)
    return { ok: true }
  },
  templates_apply: async (args) => {
    const { id, variables } = args as { id: string; variables?: Record<string, unknown> }
    const tpl = templates.find((t) => t.id === id)
    if (!tpl) throw new Error(`Template ${id} not found`)
    return {
      title: tpl.name,
      body: applyVariables(tpl.body, variables ?? {}),
      properties: tpl.frontmatter
    }
  }
}
