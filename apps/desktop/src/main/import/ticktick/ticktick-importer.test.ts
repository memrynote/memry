import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createImportContext } from '../import-context'
import { buildTickTickPreview, runTickTickImport } from './ticktick-importer'
import type { ApplyDeps } from './apply-plan'

const PREAMBLE = '﻿"Date: 2026-06-15+0000"\n"Version: 7.2"\n"Status: \n0 Normal"\n'
const HEADER =
  '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","projectKind"\n'

function dataRow(list: string, title: string, order: string): string {
  return `"","${list}","${title}","TEXT","","","N","","","","","0","0","2026-06-01T10:00:00+0000","","${order}","Europe/Istanbul","false","false","","","list","${order}","","TASK"\n`
}

function writeFixture(): string {
  const csv =
    PREAMBLE + HEADER + dataRow('Inbox', 'Buy milk', '1') + dataRow('Books', 'Read Dune', '2')
  const dir = mkdtempSync(join(tmpdir(), 'ticktick-'))
  const file = join(dir, 'TickTick.csv')
  writeFileSync(file, csv, 'utf-8')
  return file
}

function makeDeps() {
  let n = 0
  const projects: Array<{ id: string; name: string }> = []
  const tasks: Array<{ id: string; projectId: string; title: string }> = []
  const deps: ApplyDeps = {
    async createProject(a) {
      const id = `proj-${n++}`
      projects.push({ id, name: a.name })
      return { success: true, project: { id } }
    },
    async createTask(a) {
      const id = `task-${n++}`
      tasks.push({ id, projectId: a.projectId, title: a.title })
      return { success: true, task: { id } }
    },
    async completeTask() {
      return {}
    },
    async archiveTask() {
      return {}
    },
    getInboxProjectId: () => 'inbox-1',
    getStatusesByProject: () => [
      { id: 'st-todo', isDefault: true, isDone: false },
      { id: 'st-done', isDefault: false, isDone: true }
    ],
    createReminder: () => {}
  }
  return { deps, projects, tasks }
}

const ctx = () => createImportContext('test', new AbortController().signal)
const NOW = '2026-06-15T00:00:00.000Z'

describe('ticktick importer', () => {
  it('previews counts without writing', async () => {
    const preview = await buildTickTickPreview([writeFixture()], NOW)
    const group = preview.groups[0]
    expect(group.label).toBe('TickTick.csv')
    const taskCount = group.counts.find((c) => c.labelKey === 'import.stats.tasks')
    expect(taskCount?.value).toBe(2)
    expect(group.sampleTitles).toContain('Buy milk')
  })

  it('reports a per-file parse error without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticktick-bad-'))
    const file = join(dir, 'bad.csv')
    writeFileSync(file, '"just","data"\n', 'utf-8')
    const preview = await buildTickTickPreview([file], NOW)
    expect(preview.groups[0].error).toBeDefined()
  })

  it('applies tasks through the deps and streams imported progress', async () => {
    const { deps, tasks } = makeDeps()
    const context = ctx()
    await runTickTickImport([writeFixture()], deps, context, NOW)
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['Buy milk', 'Read Dune']))
    const summary = context.toSummary()
    expect(summary.imported).toBe(2)
  })
})
