// Captures the pre-sync template files and Electron's import of them for the Tauri legacy
// template import (Step 13l, #3530): crates/memry-desktop/tests/fixtures/electron-templates.
//
//   pnpm install                           (repo root)
//   node scripts/electron-fixtures/capture-templates.mjs
//
// Builds before #938 kept custom templates as `.memry/templates/<id>.md` and wrote every
// built-in there too. Their writer, `serializeTemplate` (apps/desktop/src/main/vault/templates.ts
// at 8946af3c5a^), is reproduced below verbatim, over gray-matter as it ran. A few hand edits
// sit beside the written files, among them two Electron imports differently from the Tauri
// import (an unquoted date, which it drops; see `template_legacy`). Electron's own `migrateTemplateFilesToDb`
// (`vault/templates-migration.ts`) then imports the folder into a test data DB, and its rows are
// `expected.json` (the clock column left out: Electron leaves it NULL for `seedUnclocked`, the
// core stamps one). `built-ins.json` is Electron's `BUILT_IN_TEMPLATES` itself, which pins the
// core's copy (`template_admin::BUILT_INS`). The files replace the whole fixture.
//
// The capture runs under the desktop app's vitest config, so it writes its test into
// apps/desktop/src/main/vault for the run and removes it after.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const testFile = path.join(desktop, 'src/main/vault/electron-templates-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-desktop/tests/fixtures/electron-templates')

const TEST = `/**
 * Writes the pre-sync template files of the Tauri legacy import tests and Electron's import
 * of them (\`crates/memry-desktop/tests/fixtures/electron-templates\`, Step 13l #3530). Runs
 * only with \`MEMRY_ELECTRON_TEMPLATES_OUT=<dir>\`.
 */
import { describe, it, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import matter from 'gray-matter'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb } from '@tests/utils/test-db'
import { BUILT_IN_TEMPLATES } from './built-in-templates'
import { migrateTemplateFilesToDb } from './templates-migration'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const OUT = process.env.MEMRY_ELECTRON_TEMPLATES_OUT

// serializeTemplate of apps/desktop/src/main/vault/templates.ts at 8946af3c5a^, verbatim.
function serializeTemplate(template: any): string {
  const frontmatter: Record<string, unknown> = {
    id: template.id,
    name: template.name,
    isBuiltIn: template.isBuiltIn,
    createdAt: template.createdAt,
    modifiedAt: template.modifiedAt
  }

  if (template.description) {
    frontmatter.description = template.description
  }

  if (template.icon) {
    frontmatter.icon = template.icon
  }

  if (template.tags.length > 0) {
    frontmatter.tags = template.tags
  }

  if (template.properties.length > 0) {
    frontmatter.properties = template.properties
  }

  return matter.stringify(template.content, frontmatter)
}

describe.skipIf(!OUT)('electron templates fixture', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-templates-'))
  const dir = path.join(vault, '.memry', 'templates')
  fs.mkdirSync(dir, { recursive: true })
  afterAll(() => fs.rmSync(vault, { recursive: true, force: true }))

  it('writes the files and imports them', () => {
    const at = '2025-01-01T00:00:00.000Z'
    const written = (template: any) =>
      fs.writeFileSync(path.join(dir, template.id + '.md'), serializeTemplate(template))

    // Every pre-sync build wrote the built-ins to disk.
    for (const builtIn of BUILT_IN_TEMPLATES) {
      written({ ...builtIn, createdAt: at, modifiedAt: at })
    }
    written({
      id: 'k3j9x2m1q8wz',
      name: 'Weekly Plan — Ünïcode',
      description: 'Plan the week: goals, "quotes" and colons',
      icon: '🗓️',
      isBuiltIn: false,
      tags: ['planning', 'Weekly'],
      properties: [
        { name: 'summary', type: 'text', value: '' },
        { name: 'points', type: 'number', value: 3 },
        { name: 'done', type: 'checkbox', value: false },
        { name: 'due', type: 'date', value: null },
        { name: 'stage', type: 'select', value: 'draft', options: ['draft', 'final'] },
        { name: 'areas', type: 'multiselect', value: ['home', 'work'], options: ['home', 'work'] },
        { name: 'link', type: 'url', value: 'https://example.com/a?b=c#d' },
        { name: 'energy', type: 'rating', value: 4 },
        { name: 'project', type: 'project', value: null }
      ],
      content: '# {{title}}\\n\\n## Goals\\n\\n- [ ] first goal {task:t1abc}\\n- [ ] second\\n\\n> 2025-01-01: keep this\\n',
      createdAt: '2025-03-04T05:06:07.890Z',
      modifiedAt: '2025-03-05T05:06:07.890Z'
    })
    written({
      id: 'minimal0001',
      name: 'Minimal',
      isBuiltIn: false,
      tags: [],
      properties: [],
      content: '',
      createdAt: '2025-02-01T00:00:00.000Z',
      modifiedAt: '2025-02-01T00:00:00.000Z'
    })
    written({
      id: 'realid42',
      name: 'Named apart from its file',
      isBuiltIn: false,
      tags: ['x'],
      properties: [],
      content: '\\n\\n  Padded body  \\n\\n',
      createdAt: '2025-02-02T00:00:00.000Z',
      modifiedAt: '2025-02-02T00:00:00.000Z'
    })
    fs.renameSync(path.join(dir, 'realid42.md'), path.join(dir, 'file-name-differs.md'))
    // Hand edits: no id (the file name is the id), no name, quoted timestamps.
    fs.writeFileSync(path.join(dir, 'fromfilename.md'),
      "---\\ncreatedAt: '2024-12-24T10:00:00.000Z'\\nmodifiedAt: '2024-12-25T10:00:00.000Z'\\ntags:\\n  - hand\\n---\\nWritten by hand.\\n")
    // A YAML number where text goes: SQLite's text affinity stores it as its digits.
    fs.writeFileSync(path.join(dir, 'numeric-name.md'), "---\\nname: 2024\\ntags:\\n  - year\\ncreatedAt: '2024-01-01T00:00:00.000Z'\\nmodifiedAt: '2024-01-02T00:00:00.000Z'\\n---\\nThe year.\\n")
    // An unquoted timestamp is a YAML Date, which Electron's driver cannot bind: never imported.
    fs.writeFileSync(path.join(dir, 'unquoted-dates.md'), '---\\nid: dated1\\nname: Dated\\ncreatedAt: 2024-05-06T07:08:09.000Z\\n---\\nBody\\n')
    // Frontmatter that does not parse is skipped, and the import is still flagged.
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\\nname: [unclosed\\n---\\nbody\\n')
    // Not markdown: never read.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a template')

    const test = createTestDataDb()
    try {
      const imported = migrateTemplateFilesToDb(test.db as never, vault)
      const rows = test.db
        .select()
        .from(templates)
        .all()
        .map(({ clock: _clock, syncedAt: _syncedAt, ...row }) => row)
        .sort((a, b) => a.id.localeCompare(b.id))

      const out = OUT as string
      fs.rmSync(out, { recursive: true, force: true })
      fs.mkdirSync(path.join(out, 'templates'), { recursive: true })
      fs.writeFileSync(path.join(out, '.gitattributes'), '* -text -whitespace\\n')
      for (const name of fs.readdirSync(dir).sort()) {
        fs.copyFileSync(path.join(dir, name), path.join(out, 'templates', name))
      }
      fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify({ imported, rows }, null, 2) + '\\n')
      fs.writeFileSync(path.join(out, 'built-ins.json'), JSON.stringify(BUILT_IN_TEMPLATES, null, 2) + '\\n')
    } finally {
      test.close()
    }
  })
})
`

fs.writeFileSync(testFile, TEST)
try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', '--project', 'main', testFile],
    { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_ELECTRON_TEMPLATES_OUT: out } }
  )
  if (run.status !== 0) process.exitCode = run.status ?? 1
} finally {
  fs.rmSync(testFile, { force: true })
}
