import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  previewTodoistImport,
  runTodoistImport,
  type ImportTasksDomain
} from './todoist-import-service.ts'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

function fixtureCsv(): string {
  return (
    HEADER +
    '\n' +
    'meta,view_style=list,,,,,,,,,,,,,\n' +
    'task,parent,,,4,1,Kaan,,,,,,,,\n' +
    'task,child,,,1,2,Kaan,,,,,,,,\n' +
    'task,repair home,,,2,1,Kaan,,2026-12-31,en,Europe/Istanbul,,,,\n'
  )
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'todoist-'))
  const file = join(dir, 'Kişisel.csv')
  writeFileSync(file, fixtureCsv(), 'utf-8')
  return file
}

interface RecordedTask {
  id: string
  projectId: string
  parentId: string | null
  title: string
  priority: number
  dueDate: string | null
  position: number
}

function createFakeDomain() {
  const projects: Array<{ id: string; name: string }> = []
  const tasks: RecordedTask[] = []
  const domain: ImportTasksDomain = {
    async createProject({ name }) {
      const project = { id: `p${projects.length}`, name }
      projects.push(project)
      return { project }
    },
    async createTask(input) {
      const task: RecordedTask = { id: `t${tasks.length}`, ...input }
      tasks.push(task)
      return { task }
    }
  }
  return { projects, tasks, domain }
}

describe('todoist import service', () => {
  const now = new Date(2026, 5, 15, 9, 0, 0)

  it('previews counts without writing', async () => {
    const file = writeFixture()
    const preview = await previewTodoistImport([file], now)
    expect(preview[0]).toMatchObject({
      fileName: 'Kişisel.csv',
      projectName: 'Kişisel',
      stats: { tasks: 3, subtasks: 1 }
    })
    expect(preview[0].error).toBeUndefined()
  })

  it('reports an error per file when the file cannot be read', async () => {
    const preview = await previewTodoistImport(['/no/such/file.csv'], now)
    expect(preview[0].error).toBeTruthy()
  })

  it('creates a project + tasks + subtask via the domain', async () => {
    const file = writeFixture()
    const { projects, tasks, domain } = createFakeDomain()

    const summary = await runTodoistImport([file], { domain, now })

    expect(summary.files[0]).toMatchObject({ projectName: 'Kişisel', projectId: 'p0' })
    expect(projects).toHaveLength(1)
    expect(tasks).toHaveLength(3)

    const [parent, child, repairHome] = tasks
    expect(parent).toMatchObject({ title: 'parent', priority: 4, parentId: null })
    // child resolves its parent's real id
    expect(child).toMatchObject({ title: 'child', parentId: parent.id })
    expect(repairHome).toMatchObject({
      title: 'repair home',
      priority: 2,
      dueDate: '2026-12-31',
      parentId: null
    })
    // all tasks land in the new project, positions preserved
    expect(tasks.every((t) => t.projectId === 'p0')).toBe(true)
    expect(tasks.map((t) => t.position)).toEqual([0, 1, 2])
  })

  it('isolates a failing file without aborting the batch', async () => {
    const good = writeFixture()
    const { domain } = createFakeDomain()
    const summary = await runTodoistImport(['/no/such/file.csv', good], { domain, now })
    expect(summary.files).toHaveLength(2)
    expect(summary.files[0].error).toBeTruthy()
    expect(summary.files[0].projectId).toBeNull()
    expect(summary.files[1].projectId).toBe('p0')
  })
})
