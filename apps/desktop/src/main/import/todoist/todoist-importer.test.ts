import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createImportContext } from '../import-context'
import { buildTodoistPreview, applyTodoistImport, type ImportTasksDomain } from './todoist-importer'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

function writeFixture(): string {
  const csv =
    HEADER +
    '\n' +
    'meta,view_style=list,,,,,,,,,,,,,\n' +
    'task,parent,,,4,1,Kaan,,,,,,,,\n' +
    'task,child,,,1,2,Kaan,,,,,,,,\n' +
    'task,repair home,,,2,1,Kaan,,2026-12-31,en,Europe/Istanbul,,,,\n'
  const dir = mkdtempSync(join(tmpdir(), 'todoist-'))
  const file = join(dir, 'Kişisel.csv')
  writeFileSync(file, csv, 'utf-8')
  return file
}

function createFakeDomain() {
  const projects: Array<{ id: string; name: string }> = []
  const tasks: Array<{
    id: string
    projectId: string
    parentId: string | null
    title: string
    position: number
  }> = []
  const domain: ImportTasksDomain = {
    async createProject({ name }) {
      const project = { id: `p${projects.length}`, name }
      projects.push(project)
      return { project }
    },
    async createTask(input) {
      const task = { id: `t${tasks.length}`, ...input }
      tasks.push(task)
      return { task }
    }
  }
  return { projects, tasks, domain }
}

const ctx = () => createImportContext('test', new AbortController().signal)
const now = new Date(2026, 5, 15, 9, 0, 0)

describe('todoist importer', () => {
  it('previews counts without writing', async () => {
    const preview = await buildTodoistPreview([writeFixture()], now)
    expect(preview.groups[0].label).toBe('Kişisel')
    const tasks = preview.groups[0].counts.find((c) => c.labelKey === 'import.stats.tasks')
    const subtasks = preview.groups[0].counts.find((c) => c.labelKey === 'import.stats.subtasks')
    expect(tasks?.value).toBe(3)
    expect(subtasks?.value).toBe(1)
    expect(preview.groups[0].error).toBeUndefined()
  })

  it('reports a group error when a file cannot be read', async () => {
    const preview = await buildTodoistPreview(['/no/such/file.csv'], now)
    expect(preview.groups[0].error).toBeTruthy()
    expect(preview.groups[0].counts).toEqual([])
  })

  it('creates project + tasks + subtask and summarizes imported count', async () => {
    const { projects, tasks, domain } = createFakeDomain()
    const c = ctx()
    await applyTodoistImport([writeFixture()], domain, c, now)
    expect(projects).toHaveLength(1)
    expect(tasks).toHaveLength(3)
    // child resolves its parent's real id
    expect(tasks[1]).toMatchObject({ title: 'child', parentId: tasks[0].id })
    expect(tasks.every((t) => t.projectId === 'p0')).toBe(true)
    expect(c.toSummary()).toMatchObject({ imported: 3, failed: [] })
  })

  it('isolates a failing file without aborting the batch', async () => {
    const { domain } = createFakeDomain()
    const c = ctx()
    await applyTodoistImport(['/no/such/file.csv', writeFixture()], domain, c, now)
    const summary = c.toSummary()
    expect(summary.imported).toBe(3)
    expect(summary.failed).toHaveLength(1)
  })
})
