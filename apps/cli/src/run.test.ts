import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-run')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

function makeVaultRegistry(vaults: Array<{ path: string; name: string; isDefault?: boolean }>) {
  return {
    async listVaults() {
      return vaults
    },
    async getDefaultVaultPath() {
      return vaults.find((vault) => vault.isDefault)?.path ?? null
    },
    async setDefaultVaultPath(reference: string) {
      const vault = vaults.find((item) => item.path === reference || item.name === reference)
      if (!vault) throw new Error(`Unknown vault: ${reference}`)
      vaults.splice(
        0,
        vaults.length,
        ...vaults.map((item) => ({ ...item, isDefault: item.path === vault.path }))
      )
      return { ...vault, isDefault: true }
    }
  }
}

function makeVaultStatusApp(vaultPath: string) {
  return {
    vault: {
      status() {
        return { isOpen: true, path: vaultPath }
      }
    },
    close() {}
  } as never
}

async function runCliProcess(args: string[]): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'bin/memrynote.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('uses the configured default vault when --vault is omitted', async () => {
  const vaultPath = await makeVault()
  const stdout: string[] = []
  const stderr: string[] = []

  const code = await runCli(
    ['--json', 'vault', 'status'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    },
    {
      createApp: async ({ vaultPath }) => makeVaultStatusApp(vaultPath),
      vaultRegistry: makeVaultRegistry([{ path: vaultPath, name: 'Personal', isDefault: true }])
    }
  )

  assert.equal(code, 0, stderr.join('\n'))
  assert.equal(JSON.parse(stdout.at(-1) ?? '{}').path, vaultPath)
})

test('changes the default vault from the CLI', async () => {
  const personalPath = await makeVault()
  const workPath = await makeVault()
  const registry = makeVaultRegistry([
    { path: personalPath, name: 'personal', isDefault: true },
    { path: workPath, name: 'work', isDefault: false }
  ])
  const stdout: string[] = []
  const stderr: string[] = []

  const useCode = await runCli(
    ['--json', 'vault', 'use', 'work'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    },
    { vaultRegistry: registry }
  )

  assert.equal(useCode, 0, stderr.join('\n'))
  assert.equal(JSON.parse(stdout.at(-1) ?? '{}').path, workPath)

  const currentCode = await runCli(
    ['--json', 'vault', 'current'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    },
    { vaultRegistry: registry }
  )

  assert.equal(currentCode, 0, stderr.join('\n'))
  assert.equal(JSON.parse(stdout.at(-1) ?? '{}').path, workPath)
})

test('does not guess when multiple known vaults have no default', async () => {
  const stdout: string[] = []
  const stderr: string[] = []

  const code = await runCli(
    ['notes', 'list'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    },
    {
      vaultRegistry: makeVaultRegistry([
        { path: '/vaults/personal', name: 'personal' },
        { path: '/vaults/work', name: 'work' }
      ])
    }
  )

  assert.equal(code, 1)
  assert.match(stderr.join('\n'), /Multiple vaults found/)
  assert.equal(stdout.length, 0)
})

test('initializes a new vault when several CLI processes start concurrently', async () => {
  const vaultPath = await makeVault()
  const results = await Promise.all(
    [
      ['--vault', vaultPath, '--json', 'agent', 'local-settings'],
      ['--vault', vaultPath, '--json', 'agent', 'models', '--backend', 'codex_cli'],
      ['--vault', vaultPath, '--json', 'agent', 'backends'],
      ['--vault', vaultPath, '--json', 'sync', 'status'],
      ['--vault', vaultPath, '--json', 'vault', 'status'],
      ['--vault', vaultPath, '--json', 'notes', 'list'],
      ['--vault', vaultPath, '--json', 'calendar', 'events', 'list'],
      ['--vault', vaultPath, '--json', 'settings', 'list']
    ].map((args) => runCliProcess(args))
  )

  assert.deepEqual(
    results.map((result) => result.code),
    Array.from({ length: results.length }, () => 0),
    results.map((result) => result.stderr || result.stdout).join('\n')
  )
  for (const result of results) {
    assert.doesNotThrow(() => JSON.parse(result.stdout))
  }
})

test('runs core commands against a vault and prints JSON output', async () => {
  const vaultPath = await makeVault()
  const stdout: string[] = []
  const stderr: string[] = []

  const initCode = await runCli(['--vault', vaultPath, '--json', 'vault', 'init'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(initCode, 0)

  const noteCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'create',
      'CLI Note',
      '--content',
      'Created from CLI',
      '--folder',
      'Projects',
      '--properties',
      '{"source":"cli"}',
      '--tag',
      'cli'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteCode, 0)
  const note = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    title?: string
    content?: string
    properties?: Record<string, unknown>
  }
  assert.equal(note.title, 'CLI Note')
  assert.equal(note.content, 'Created from CLI\n')
  assert.deepEqual(note.properties, { source: 'cli' })

  const linkedNoteCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'create', 'Linked Note', '--content', 'Linked body'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(linkedNoteCode, 0)
  const linkedNote = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; path?: string }

  const noteLinksUpdateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'update',
      note.id ?? '',
      '--content',
      'Created from CLI [[Linked Note]] [[Missing Note]]'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteLinksUpdateCode, 0)

  const noteExistsCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'exists', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteExistsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { exists?: boolean }).exists, true)

  const notePreviewCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'preview', 'Linked Note'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(notePreviewCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }).id, linkedNote.id)

  const noteResolveCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'resolve', 'Linked Note'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteResolveCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { path?: string }).path, linkedNote.path)

  const noteResolveHeadingCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'resolve', 'Linked Note#Details'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteResolveHeadingCode, 0)
  // #1557: `[[Note#Heading]]` used to resolve to nothing at all here.
  const resolvedHeading = JSON.parse(stdout.at(-1) ?? '{}') as {
    path?: string
    heading?: string | null
  }
  assert.equal(resolvedHeading.path, linkedNote.path)
  assert.equal(resolvedHeading.heading, 'Details')

  const noteLinksCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'links', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteLinksCode, 0)
  assert.equal(
    (
      JSON.parse(stdout.at(-1) ?? '{}') as {
        outgoing?: Array<{ title?: string; noteId?: string | null }>
      }
    ).outgoing?.some((link) => link.title === 'Linked Note' && link.noteId === linkedNote.id),
    true
  )

  const configUpdateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'vault',
      'update-config',
      '{"excludePatterns":[".git","tmp"]}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(configUpdateCode, 0)
  assert.deepEqual(
    (JSON.parse(stdout.at(-1) ?? '{}') as { excludePatterns?: string[] }).excludePatterns,
    ['.git', 'tmp']
  )

  const propertiesSetCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'properties',
      'set',
      note.id ?? '',
      '{"status":"active","priority":3}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(propertiesSetCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), {
    status: 'active',
    priority: 3
  })

  const propertiesRenameCode = await runCli(
    ['--vault', vaultPath, '--json', 'properties', 'rename', note.id ?? '', 'status', 'state'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(propertiesRenameCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), {
    state: 'active',
    priority: 3
  })

  const definePropertyCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'properties',
      'define',
      'mood',
      'select',
      '--options',
      '[{"value":"Focused","color":"emerald"}]',
      '--default',
      '"Focused"'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(definePropertyCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { name?: string }).name, 'mood')

  const definitionsCode = await runCli(
    ['--vault', vaultPath, '--json', 'properties', 'definitions'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(definitionsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ name?: string }>).some(
      (definition) => definition.name === 'mood'
    ),
    true
  )

  const updateDefinitionCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'properties',
      'update-definition',
      'mood',
      '--options',
      '[{"value":"Calm","color":"sky"}]'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(updateDefinitionCode, 0)

  const deleteDefinitionCode = await runCli(
    ['--vault', vaultPath, '--json', 'properties', 'delete-definition', 'mood', '--yes'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(deleteDefinitionCode, 0)

  const snapshotCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'snapshot', note.id ?? '', '--force'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(snapshotCode, 0)
  const snapshot = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; noteId?: string }
  assert.equal(snapshot.noteId, note.id)

  const versionsCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'versions', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(versionsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>)[0]?.id, snapshot.id)

  const versionCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'version', snapshot.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(versionCode, 0)
  // Vault files carry no Memry title key; the snapshot stores the file verbatim
  assert.match(
    (JSON.parse(stdout.at(-1) ?? '{}') as { fileContent?: string }).fileContent ?? '',
    /Created from CLI/
  )

  const attachmentSource = path.join(vaultPath, 'sample.txt')
  await fs.writeFile(attachmentSource, 'attachment body', 'utf-8')
  const attachCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'attach', note.id ?? '', attachmentSource],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(attachCode, 0)
  const attachment = JSON.parse(stdout.at(-1) ?? '{}') as { filename?: string; name?: string }
  assert.equal(attachment.name, 'sample.txt')

  const attachmentsCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'attachments', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(attachmentsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ filename?: string }>)[0]?.filename,
    attachment.filename
  )

  const importSource = path.join(vaultPath, 'import.md')
  await fs.writeFile(importSource, '# Imported\n\nImported body', 'utf-8')
  const importCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'import-files', importSource, '--folder', 'Projects'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(importCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { imported?: number }).imported, 1)

  const htmlExportPath = path.join(vaultPath, 'cli-note.html')
  const pdfExportPath = path.join(vaultPath, 'cli-note.pdf')
  const exportHtmlCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'export-html',
      note.id ?? '',
      htmlExportPath,
      '--include-metadata'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(exportHtmlCode, 0)
  assert.match(await fs.readFile(htmlExportPath, 'utf-8'), /Created from CLI/)

  const exportPdfCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'export-pdf',
      note.id ?? '',
      pdfExportPath,
      '--include-metadata'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(exportPdfCode, 0)
  assert.match(await fs.readFile(pdfExportPath, 'utf-8'), /^%PDF-/)

  const deleteAttachmentCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'delete-attachment',
      note.id ?? '',
      attachment.filename ?? '',
      '--yes'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(deleteAttachmentCode, 0)

  const fileNoteCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'create', 'File Note', '--content', 'Move me'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(fileNoteCode, 0)
  const fileNote = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const noteRenameCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'rename', fileNote.id ?? '', 'Renamed File Note'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteRenameCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { title?: string }).title, 'Renamed File Note')

  const noteMoveCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'move', fileNote.id ?? '', 'Moved'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteMoveCode, 0)
  const movedFileNote = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; path?: string }
  assert.match(movedFileNote.path ?? '', /^Moved\//)

  const localOnlyCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'set-local-only', movedFileNote.id ?? '', 'true'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(localOnlyCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { localOnly?: boolean }).localOnly, true)

  const localOnlyCountCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'local-only-count'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(localOnlyCountCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { count?: number }).count, 1)

  const syncStatusCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'status'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncStatusCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { status?: string }).status, 'idle')

  const syncQueueCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'queue-size'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncQueueCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { pending?: number }).pending, 0)

  const syncPauseCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'pause'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncPauseCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const syncResumeCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'resume'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncResumeCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const syncDevicesCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'devices'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncDevicesCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { devices?: unknown[] }).devices?.length, 0)

  const syncHistoryCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'history'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncHistoryCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { total?: number }).total, 0)

  const syncedSettingCode = await runCli(
    ['--vault', vaultPath, '--json', 'sync', 'update-setting', 'sync.autoSync', 'false'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(syncedSettingCode, 0)
  const syncedSettingsCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'settings'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncedSettingsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { sync?: { autoSync?: boolean } }).sync?.autoSync,
    false
  )

  const syncStorageCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'storage'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncStorageCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { used?: number }).used! > 0, true)

  const syncDeviceStatusCode = await runCli(
    ['--vault', vaultPath, '--json', 'sync', 'check-device'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(syncDeviceStatusCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), { status: 'unknown' })

  const syncQuarantineCode = await runCli(['--vault', vaultPath, '--json', 'sync', 'quarantine'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(syncQuarantineCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '[]'), [])

  const localeListCode = await runCli(['--vault', vaultPath, '--json', 'locale', 'list'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(localeListCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '[]') as string[]).includes('tr'), true)

  const localeGetCode = await runCli(['--vault', vaultPath, '--json', 'locale', 'get'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(localeGetCode, 0)
  assert.equal(JSON.parse(stdout.at(-1) ?? 'null'), 'en')

  const localeSetCode = await runCli(['--vault', vaultPath, '--json', 'locale', 'set', 'tr'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(localeSetCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), { locale: 'tr' })

  const localeSettingsCode = await runCli(
    ['--vault', vaultPath, '--json', 'settings', 'group', 'general'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(localeSettingsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { language?: string }).language, 'tr')

  const agentBackendsCode = await runCli(['--vault', vaultPath, '--json', 'agent', 'backends'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(agentBackendsCode, 0)
  const agentBackends = JSON.parse(stdout.at(-1) ?? '{}') as {
    codex_cli?: { backend?: string }
    local_openai_compatible?: { backend?: string }
  }
  assert.equal(agentBackends.codex_cli?.backend, 'codex_cli')
  assert.equal(agentBackends.local_openai_compatible?.backend, 'local_openai_compatible')

  const agentModelsCode = await runCli(
    ['--vault', vaultPath, '--json', 'agent', 'models', '--backend', 'codex_cli'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(agentModelsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { backend?: string }).backend, 'codex_cli')

  const agentLocalSettingsCode = await runCli(
    ['--vault', vaultPath, '--json', 'agent', 'local-settings'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(agentLocalSettingsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { preset?: string }).preset, 'ollama')

  const agentSetLocalSettingsCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'agent',
      'set-local-settings',
      '--preset',
      'lm_studio',
      '--model',
      'qwen',
      '--allow-non-loopback',
      'false'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(agentSetLocalSettingsCode, 0)
  const localProviderSettings = JSON.parse(stdout.at(-1) ?? '{}') as {
    preset?: string
    baseUrl?: string
    model?: string
    apiKeyConfigured?: boolean
  }
  assert.equal(localProviderSettings.preset, 'lm_studio')
  assert.equal(localProviderSettings.baseUrl, 'http://localhost:1234/v1')
  assert.equal(localProviderSettings.model, 'qwen')
  assert.equal(localProviderSettings.apiKeyConfigured, false)

  const taskCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'create',
      'CLI task',
      '--priority',
      '2',
      '--link-note',
      note.id ?? '',
      '--source-note',
      note.id ?? '',
      '--repeat',
      '{"frequency":"daily","interval":1,"endType":"never","completedCount":0,"createdAt":"2026-05-13T00:00:00.000Z"}',
      '--repeat-from',
      'due'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskCode, 0)
  const task = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    title?: string
    priority?: number
    linkedNoteIds?: string[]
    sourceNoteId?: string | null
  }
  assert.equal(task.title, 'CLI task')
  assert.equal(task.priority, 2)
  assert.deepEqual(task.linkedNoteIds, [note.id])
  assert.equal(task.sourceNoteId, note.id)

  const projectForTaskCode = await runCli(
    ['--vault', vaultPath, '--json', 'projects', 'create', 'Task Project'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(projectForTaskCode, 0)
  const projectForTask = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; name?: string }

  const projectUpdateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'projects',
      'update',
      projectForTask.id ?? '',
      '--name',
      'Task Project Updated',
      '--color',
      '#0ea5e9'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(projectUpdateCode, 0)

  const statusCreateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'projects',
      'status-create',
      projectForTask.id ?? '',
      'Review',
      '--color',
      '#0ea5e9'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(statusCreateCode, 0)
  const reviewStatus = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; name?: string }

  const statusesCode = await runCli(
    ['--vault', vaultPath, '--json', 'projects', 'statuses', projectForTask.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(statusesCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (status) => status.id === reviewStatus.id
    ),
    true
  )

  const taskMoveCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'move',
      (task as { id?: string }).id ?? '',
      '--project',
      projectForTask.id ?? '',
      '--status',
      reviewStatus.id ?? '',
      '--position',
      '0'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskMoveCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { statusId?: string }).statusId,
    reviewStatus.id
  )

  const taskUpdateLinksCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'update',
      task.id ?? '',
      '--link-note',
      note.id ?? '',
      '--repeat',
      'null',
      '--source-note',
      'null'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskUpdateLinksCode, 0)

  const childTaskCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'create',
      'Child task',
      '--project',
      projectForTask.id ?? '',
      '--parent',
      task.id ?? '',
      '--due',
      '2026-05-12',
      '--tag',
      'child'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(childTaskCode, 0)
  const childTask = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; parentId?: string | null }

  const subtasksCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'get-subtasks', task.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(subtasksCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (subtask) => subtask.id === childTask.id
    ),
    true
  )

  const linkedTasksCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'get-linked-tasks', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(linkedTasksCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (linkedTask) => linkedTask.id === task.id
    ),
    true
  )

  const convertToTaskCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'convert-to-task', childTask.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(convertToTaskCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { parentId?: string | null }).parentId, null)

  const convertToSubtaskCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'convert-to-subtask',
      childTask.id ?? '',
      task.id ?? ''
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(convertToSubtaskCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { parentId?: string | null }).parentId,
    task.id
  )

  const todayTasksCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'today', '--date', '2026-05-12'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(todayTasksCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (dueTask) => dueTask.id === childTask.id
    ),
    true
  )

  const upcomingTasksCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'upcoming', '--from', '2026-05-12', '--days', '3'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(upcomingTasksCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (dueTask) => dueTask.id === childTask.id
    ),
    true
  )

  const overdueTasksCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'overdue', '--date', '2026-05-13'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(overdueTasksCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).some(
      (dueTask) => dueTask.id === childTask.id
    ),
    true
  )

  const taskStatsCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'stats', '--date', '2026-05-13'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskStatsCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { total?: number }).total ?? 0 >= 2)

  const taskTagsCode = await runCli(['--vault', vaultPath, '--json', 'tasks', 'tags'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(taskTagsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ tag?: string; count?: number }>).some(
      (tag) => tag.tag === 'child' && tag.count === 1
    ),
    true
  )

  const secondTaskProjectCode = await runCli(
    ['--vault', vaultPath, '--json', 'projects', 'create', 'Second Task Project'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(secondTaskProjectCode, 0)
  const secondTaskProject = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const taskBulkMoveCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'bulk-move',
      childTask.id ?? '',
      '--project',
      secondTaskProject.id ?? ''
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskBulkMoveCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { count?: number }).count, 1)

  const taskReorderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'tasks',
      'reorder',
      childTask.id ?? '',
      task.id ?? '',
      '--position',
      '0',
      '--position',
      '1'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskReorderCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const projectGetCode = await runCli(
    ['--vault', vaultPath, '--json', 'projects', 'get', projectForTask.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(projectGetCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }).id, projectForTask.id)

  const projectReorderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'projects',
      'reorder',
      secondTaskProject.id ?? '',
      projectForTask.id ?? '',
      '--position',
      '0',
      '--position',
      '1'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(projectReorderCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const statusReorderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'projects',
      'status-reorder',
      reviewStatus.id ?? '',
      '--position',
      '0'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(statusReorderCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const duplicateTaskCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'duplicate', task.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(duplicateTaskCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { title?: string }).title, 'Copy of CLI task')

  const bulkACode = await runCli(['--vault', vaultPath, '--json', 'tasks', 'create', 'Bulk A'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(bulkACode, 0)
  const bulkA = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }
  const bulkBCode = await runCli(['--vault', vaultPath, '--json', 'tasks', 'create', 'Bulk B'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(bulkBCode, 0)
  const bulkB = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }
  const bulkDoneCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'bulk-done', bulkA.id ?? '', bulkB.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bulkDoneCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { count?: number }).count, 2)

  const taskArchiveCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'archive', task.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskArchiveCode, 0)

  const taskUnarchiveCode = await runCli(
    ['--vault', vaultPath, '--json', 'tasks', 'unarchive', (task as { id?: string }).id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(taskUnarchiveCode, 0)

  const statusUpdateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'projects',
      'status-update',
      reviewStatus.id ?? '',
      '--name',
      'Reviewed',
      '--done',
      'true'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(statusUpdateCode, 0)

  const statusDeleteCode = await runCli(
    ['--vault', vaultPath, '--json', 'projects', 'status-delete', reviewStatus.id ?? '', '--yes'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(statusDeleteCode, 0)

  const folderCode = await runCli(
    ['--vault', vaultPath, '--json', 'folders', 'create', 'Projects'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(folderCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { path?: string }).path, 'Projects')

  const referenceFolderCode = await runCli(
    ['--vault', vaultPath, '--json', 'folders', 'create', 'Reference'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(referenceFolderCode, 0)

  const folderViewSetCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'folder-view',
      'set-view',
      'Projects',
      '{"name":"Table","type":"table","default":true,"columns":[{"id":"title"},{"id":"state"}]}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(folderViewSetCode, 0)

  const folderViewListCode = await runCli(
    ['--vault', vaultPath, '--json', 'folder-view', 'list', 'Projects'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(folderViewListCode, 0)
  const folderViewRows = JSON.parse(stdout.at(-1) ?? '{}') as {
    notes?: Array<{ id?: string; properties?: Record<string, unknown> }>
  }
  assert.deepEqual(folderViewRows.notes?.find((row) => row.id === note.id)?.properties, {
    state: 'active',
    priority: 3
  })

  const folderViewPropertiesCode = await runCli(
    ['--vault', vaultPath, '--json', 'folder-view', 'properties', 'Projects'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(folderViewPropertiesCode, 0)
  const folderViewProperties = JSON.parse(stdout.at(-1) ?? '{}') as {
    properties?: Array<{ name?: string }>
  }
  assert.ok(folderViewProperties.properties?.some((property) => property.name === 'state'))

  const folderViewSuggestionsCode = await runCli(
    ['--vault', vaultPath, '--json', 'folder-view', 'suggestions', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(folderViewSuggestionsCode, 0)
  assert.equal(
    (
      JSON.parse(stdout.at(-1) ?? '{}') as {
        suggestions?: Array<{ path?: string }>
      }
    ).suggestions?.some((suggestion) => suggestion.path === 'Reference'),
    true
  )

  const journalCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'append', '2026-05-13', 'CLI journal'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalCode, 0)
  const journal = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    journalDate?: string
    content?: string
  }
  assert.equal(journal.journalDate, '2026-05-13')
  assert.equal(journal.content, 'CLI journal\n')

  const journalTagCode = await runCli(
    ['--vault', vaultPath, '--json', 'notes', 'update', journal.id ?? '', '--tag', 'daily'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalTagCode, 0)

  const journalTagsCode = await runCli(['--vault', vaultPath, '--json', 'journal', 'tags'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(journalTagsCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '[]'), [{ tag: 'daily', count: 1 }])

  const journalContextCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'context', '2026-05-12'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalContextCode, 0)
  assert.equal(
    (
      JSON.parse(stdout.at(-1) ?? '{}') as {
        tasks?: Array<{ id?: string }>
      }
    ).tasks?.some((dayTask) => dayTask.id === childTask.id),
    true
  )

  const journalStatsCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'stats', '2026'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalStatsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { entries?: number }).entries, 1)

  const journalMonthCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'month', '2026', '5'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalMonthCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ journalDate?: string }>)[0]?.journalDate,
    '2026-05-13'
  )

  const tempJournalCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'write', '2026-05-12', 'Temporary journal'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(tempJournalCode, 0)
  const journalDeleteCode = await runCli(
    ['--vault', vaultPath, '--json', 'journal', 'delete', '2026-05-12', '--yes'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalDeleteCode, 0)

  const inboxCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'capture', 'CLI inbox', '--title', 'Inbox item'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxCode, 0)
  const inbox = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    title?: string
    content?: string
    tags?: string[]
    archivedAt?: string | null
    viewedAt?: string | null
  }
  assert.equal(inbox.title, 'Inbox item')
  assert.equal(inbox.content, 'CLI inbox')

  const inboxGetCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'get', inbox.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxGetCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }).id, inbox.id)

  const inboxUpdateCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'update', inbox.id ?? '', '--title', 'Inbox updated'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxUpdateCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { title?: string }).title, 'Inbox updated')

  const inboxTagCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'add-tag', inbox.id ?? '', 'follow-up'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxTagCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { tags?: string[] }).tags?.includes('follow-up'),
    true
  )

  const inboxTagsCode = await runCli(['--vault', vaultPath, '--json', 'inbox', 'tags'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(inboxTagsCode, 0)
  assert.ok(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ tag?: string; count?: number }>).some(
      (tag) => tag.tag === 'follow-up' && tag.count === 1
    )
  )

  const inboxStatsCode = await runCli(['--vault', vaultPath, '--json', 'inbox', 'stats'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(inboxStatsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { totalItems?: number }).totalItems, 1)

  const inboxPatternsCode = await runCli(['--vault', vaultPath, '--json', 'inbox', 'patterns'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(inboxPatternsCode, 0)
  const inboxPatterns = JSON.parse(stdout.at(-1) ?? '{}') as {
    timeHeatmap?: number[][]
    typeDistribution?: Array<{ type?: string; count?: number }>
    topTags?: Array<{ tag?: string }>
  }
  assert.equal(inboxPatterns.timeHeatmap?.length, 24)
  assert.equal(
    inboxPatterns.typeDistribution?.some((entry) => entry.type === 'note' && entry.count === 1),
    true
  )
  assert.equal(
    inboxPatterns.topTags?.some((tag) => tag.tag === 'follow-up'),
    true
  )

  const inboxViewedCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'mark-viewed', inbox.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxViewedCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { viewedAt?: string | null }).viewedAt)

  const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const inboxSnoozeCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'snooze',
      inbox.id ?? '',
      '--until',
      snoozedUntil,
      '--reason',
      'Later'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxSnoozeCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { snoozedUntil?: string }).snoozedUntil,
    snoozedUntil
  )

  const inboxSnoozedListCode = await runCli(['--vault', vaultPath, '--json', 'inbox', 'snoozed'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(inboxSnoozedListCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { items?: Array<{ id?: string }> }).items?.[0]?.id,
    inbox.id
  )

  const inboxListWithoutSnoozedCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'list'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxListWithoutSnoozedCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { total?: number }).total, 0)

  const inboxUnsnoozeCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'unsnooze', inbox.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxUnsnoozeCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { snoozedUntil?: string | null }).snoozedUntil,
    null
  )

  const inboxArchiveCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'archive', inbox.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxArchiveCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { archivedAt?: string | null }).archivedAt)

  const inboxUnarchiveCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'unarchive', inbox.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxUnarchiveCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { archivedAt?: string | null }).archivedAt,
    null
  )

  const inboxLinkCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'capture-link',
      'https://example.com/articles/memry-cli',
      '--tag',
      'reading'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxLinkCode, 0)
  const inboxLink = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    type?: string
    sourceUrl?: string
  }
  assert.equal(inboxLink.type, 'link')
  assert.equal(inboxLink.sourceUrl, 'https://example.com/articles/memry-cli')

  const inboxConvertNoteCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'convert-note', inboxLink.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxConvertNoteCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { noteId?: string }).noteId)

  const inboxTaskSourceCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'capture',
      'Turn this into a task',
      '--title',
      'Task inbox item'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxTaskSourceCode, 0)
  const inboxTaskSource = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const inboxConvertTaskCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'convert-task', inboxTaskSource.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxConvertTaskCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { taskId?: string }).taskId)

  const inboxLinkNoteSourceCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'capture', 'Link this to note'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxLinkNoteSourceCode, 0)
  const inboxLinkNoteSource = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const inboxLinkNoteCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'link-note',
      inboxLinkNoteSource.id ?? '',
      note.id ?? '',
      '--tag',
      'linked'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxLinkNoteCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const inboxPdfSource = path.join(vaultPath, 'sample.pdf')
  await fs.writeFile(inboxPdfSource, '%PDF-1.4\n')
  const inboxFileCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'capture-file',
      inboxPdfSource,
      '--mime',
      'application/pdf',
      '--tag',
      'pdf'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxFileCode, 0)
  const inboxFile = JSON.parse(stdout.at(-1) ?? '{}') as {
    type?: string
    attachmentPath?: string
    tags?: string[]
  }
  assert.equal(inboxFile.type, 'pdf')
  assert.ok(inboxFile.attachmentPath?.includes('/sample.pdf'))
  assert.equal(inboxFile.tags?.includes('pdf'), true)

  const bulkInboxACode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'capture', 'Bulk A', '--title', 'Bulk A'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bulkInboxACode, 0)
  const bulkInboxA = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }
  const bulkInboxBCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'capture', 'Bulk B', '--title', 'Bulk B'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bulkInboxBCode, 0)
  const bulkInboxB = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const inboxBulkTagCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'bulk-tag',
      bulkInboxA.id ?? '',
      bulkInboxB.id ?? '',
      '--tag',
      'batch'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxBulkTagCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { processedCount?: number }).processedCount, 2)

  const inboxBulkSnoozeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const inboxBulkSnoozeCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'bulk-snooze',
      bulkInboxA.id ?? '',
      bulkInboxB.id ?? '',
      '--until',
      inboxBulkSnoozeUntil
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxBulkSnoozeCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { processedCount?: number }).processedCount, 2)

  const inboxBulkArchiveCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'inbox',
      'bulk-archive',
      bulkInboxA.id ?? '',
      bulkInboxB.id ?? ''
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxBulkArchiveCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { processedCount?: number }).processedCount, 2)

  const inboxArchivedCode = await runCli(['--vault', vaultPath, '--json', 'inbox', 'archived'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(inboxArchivedCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { total?: number }).total ?? 0 >= 2)

  const inboxFilingHistoryCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'filing-history', '--limit', '10'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxFilingHistoryCode, 0)
  assert.ok(
    (JSON.parse(stdout.at(-1) ?? '{}') as { entries?: unknown[] }).entries?.length ?? 0 >= 3
  )

  const inboxStaleThresholdCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'set-stale-threshold', '14'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxStaleThresholdCode, 0)
  const inboxGetStaleThresholdCode = await runCli(
    ['--vault', vaultPath, '--json', 'inbox', 'stale-threshold'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(inboxGetStaleThresholdCode, 0)
  assert.equal(JSON.parse(stdout.at(-1) ?? '0'), 14)

  const searchCode = await runCli(['--vault', vaultPath, '--json', 'search', 'CLI Note'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(searchCode, 0)
  const search = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ kind?: string; title?: string }>
  assert.ok(search.some((result) => result.kind === 'note' && result.title === 'CLI Note'))

  const searchStatsCode = await runCli(['--vault', vaultPath, '--json', 'search', 'stats'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(searchStatsCode, 0)
  assert.ok((JSON.parse(stdout.at(-1) ?? '{}') as { totalNotes?: number }).totalNotes ?? 0 >= 4)

  const searchReasonCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'search',
      'add-reason',
      note.id ?? '',
      'note',
      'CLI Note',
      'CLI'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(searchReasonCode, 0)

  const searchReasonsCode = await runCli(['--vault', vaultPath, '--json', 'search', 'reasons'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(searchReasonsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ itemId?: string }>)[0]?.itemId,
    note.id
  )

  const tagsCode = await runCli(['--vault', vaultPath, '--json', 'tags', 'list'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(tagsCode, 0)
  const tags = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ name?: string; totalCount?: number }>
  assert.ok(tags.some((tag) => tag.name === 'cli' && tag.totalCount === 1))

  const tagNotesCode = await runCli(['--vault', vaultPath, '--json', 'tags', 'notes', 'cli'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(tagNotesCode, 0)
  assert.equal(
    (
      JSON.parse(stdout.at(-1) ?? '{}') as {
        unpinnedNotes?: Array<{ id?: string }>
      }
    ).unpinnedNotes?.some((taggedNote) => taggedNote.id === note.id),
    true
  )

  const tagMergeCode = await runCli(
    ['--vault', vaultPath, '--json', 'tags', 'merge', 'cli', 'command-line'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(tagMergeCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { success?: boolean }).success, true)

  const tagRemoveFromNoteCode = await runCli(
    ['--vault', vaultPath, '--json', 'tags', 'remove-from-note', note.id ?? '', 'command-line'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(tagRemoveFromNoteCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), { success: true })

  const settingsCode = await runCli(
    ['--vault', vaultPath, '--json', 'settings', 'set', 'editor.spellcheck', 'true'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(settingsCode, 0)
  const setting = JSON.parse(stdout.at(-1) ?? '{}') as { key?: string; value?: unknown }
  assert.equal(setting.key, 'editor.spellcheck')
  assert.equal(setting.value, true)
  const settingsGroupCode = await runCli(
    ['--vault', vaultPath, '--json', 'settings', 'group', 'general'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(settingsGroupCode, 0)
  const generalSettings = JSON.parse(stdout.at(-1) ?? '{}') as {
    theme?: string
    language?: string
  }
  assert.equal(generalSettings.theme, 'white')
  assert.equal(generalSettings.language, 'tr')

  const updateGroupCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'settings',
      'set-group',
      'general',
      '{"theme":"dark","language":"tr"}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(updateGroupCode, 0)
  const updatedGeneralSettings = JSON.parse(stdout.at(-1) ?? '{}') as {
    theme?: string
    language?: string
    createInSelectedFolder?: boolean
  }
  assert.equal(updatedGeneralSettings.theme, 'dark')
  assert.equal(updatedGeneralSettings.language, 'tr')
  assert.equal(updatedGeneralSettings.createInSelectedFolder, true)

  const voiceSettingsCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'settings',
      'set-group',
      'voiceTranscription',
      '{"provider":"openai"}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(voiceSettingsCode, 0)
  const voiceSettings = JSON.parse(stdout.at(-1) ?? '{}') as { provider?: string }
  assert.equal(voiceSettings.provider, 'openai')

  const journalSettingsCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'settings',
      'set-group',
      'journal',
      '{"defaultTemplate":"Daily Review","showSchedule":false}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(journalSettingsCode, 0)
  const journalSettings = JSON.parse(stdout.at(-1) ?? '{}') as {
    defaultTemplate?: string | null
    showSchedule?: boolean
    showTasks?: boolean
  }
  assert.equal(journalSettings.defaultTemplate, 'Daily Review')
  assert.equal(journalSettings.showSchedule, false)
  assert.equal(journalSettings.showTasks, true)

  const tabSettingsCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'settings',
      'set-group',
      'tabs',
      '{"restoreSessionOnStart":false,"tabCloseButton":"active"}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(tabSettingsCode, 0)
  const tabSettings = JSON.parse(stdout.at(-1) ?? '{}') as {
    restoreSessionOnStart?: boolean
    tabCloseButton?: string
  }
  assert.equal(tabSettings.restoreSessionOnStart, false)
  assert.equal(tabSettings.tabCloseButton, 'active')

  const noteEditorSettingsCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'settings',
      'set-group',
      'noteEditor',
      '{"toolbarMode":"sticky"}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(noteEditorSettingsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { toolbarMode?: string }).toolbarMode,
    'sticky'
  )

  const aiSettingsCode = await runCli(['--vault', vaultPath, '--json', 'settings', 'ai'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(aiSettingsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { enabled?: boolean }).enabled, true)

  const setAiSettingsCode = await runCli(
    ['--vault', vaultPath, '--json', 'settings', 'set-ai', 'false'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(setAiSettingsCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { enabled?: boolean }).enabled, false)

  const reminderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'reminders',
      'create',
      'note',
      note.id ?? '',
      '--at',
      '2026-05-14T08:00:00.000Z',
      '--title',
      'Review note'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderCode, 0)
  const reminder = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; status?: string }
  assert.equal(reminder.status, 'pending')

  const reminderUpdateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'reminders',
      'update',
      reminder.id ?? '',
      '--at',
      '2026-05-15T08:00:00.000Z',
      '--title',
      'Review note again',
      '--note',
      'Updated reminder note'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderUpdateCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { title?: string }).title, 'Review note again')

  const reminderListCode = await runCli(
    ['--vault', vaultPath, '--json', 'reminders', 'list', '--status', 'pending'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderListCode, 0)
  const reminderList = JSON.parse(stdout.at(-1) ?? '{}') as { total?: number }
  assert.equal(reminderList.total, 1)

  const reminderForTargetCode = await runCli(
    ['--vault', vaultPath, '--json', 'reminders', 'for-target', 'note', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderForTargetCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>)[0]?.id, reminder.id)

  const reminderCountCode = await runCli(
    ['--vault', vaultPath, '--json', 'reminders', 'count-pending'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderCountCode, 0)
  assert.equal(JSON.parse(stdout.at(-1) ?? '0'), 1)

  const secondReminderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'reminders',
      'create',
      'note',
      note.id ?? '',
      '--at',
      '2026-05-16T08:00:00.000Z',
      '--title',
      'Second reminder'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(secondReminderCode, 0)
  const secondReminder = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const reminderBulkDismissCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'reminders',
      'bulk-dismiss',
      reminder.id ?? '',
      secondReminder.id ?? ''
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(reminderBulkDismissCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), { success: true, dismissedCount: 2 })

  const templateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'templates',
      'create',
      'CLI Template',
      '--content',
      'Template body',
      '--tag',
      'templates'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(templateCode, 0)
  const template = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; name?: string }
  assert.equal(template.name, 'CLI Template')

  const templateListCode = await runCli(['--vault', vaultPath, '--json', 'templates', 'list'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(templateListCode, 0)
  const templates = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ name?: string }>
  assert.ok(templates.some((item) => item.name === 'CLI Template'))

  const bookmarkCode = await runCli(
    ['--vault', vaultPath, '--json', 'bookmarks', 'add', 'note', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkCode, 0)
  const bookmark = JSON.parse(stdout.at(-1) ?? '{}') as { itemType?: string; itemId?: string }
  assert.equal(bookmark.itemType, 'note')
  assert.equal(bookmark.itemId, note.id)

  const bookmarkHasCode = await runCli(
    ['--vault', vaultPath, '--json', 'bookmarks', 'has', 'note', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkHasCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { bookmarked?: boolean }).bookmarked, true)

  const bookmarkToggleCode = await runCli(
    ['--vault', vaultPath, '--json', 'bookmarks', 'toggle', 'note', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkToggleCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { bookmarked?: boolean }).bookmarked, false)

  await runCli(['--vault', vaultPath, '--json', 'bookmarks', 'toggle', 'note', note.id ?? ''], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })

  const bookmarkListCode = await runCli(['--vault', vaultPath, '--json', 'bookmarks', 'list'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(bookmarkListCode, 0)
  const bookmarks = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ itemId?: string }>
  assert.ok(bookmarks.some((item) => item.itemId === note.id))

  const bookmarkByItemCode = await runCli(
    ['--vault', vaultPath, '--json', 'bookmarks', 'get-by-item', 'note', note.id ?? ''],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkByItemCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { itemId?: string }).itemId, note.id)

  const bookmarkListByTypeCode = await runCli(
    ['--vault', vaultPath, '--json', 'bookmarks', 'list-by-type', 'note'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkListByTypeCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ itemType?: string }>).every(
      (item) => item.itemType === 'note'
    ),
    true
  )

  const bookmarkBulkCreateCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'bookmarks',
      'bulk-create',
      '[{"itemType":"task","itemId":"task_cli_bookmark"},{"itemType":"template","itemId":"template_cli_bookmark"}]'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkBulkCreateCode, 0)
  const bulkBookmarks = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>
  assert.equal(bulkBookmarks.length, 2)

  const bookmarkBulkDeleteCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'bookmarks',
      'bulk-delete',
      ...(bulkBookmarks.map((item) => item.id).filter(Boolean) as string[])
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(bookmarkBulkDeleteCode, 0)
  assert.deepEqual(JSON.parse(stdout.at(-1) ?? '{}'), { success: true })

  const filterCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'saved-filters',
      'create',
      'CLI Filter',
      '--config',
      '{"query":"CLI","tags":["cli"]}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(filterCode, 0)
  const savedFilter = JSON.parse(stdout.at(-1) ?? '{}') as {
    id?: string
    name?: string
    config?: Record<string, unknown>
  }
  assert.equal(savedFilter.name, 'CLI Filter')
  assert.deepEqual(savedFilter.config, { query: 'CLI', tags: ['cli'] })

  const filterListCode = await runCli(['--vault', vaultPath, '--json', 'saved-filters', 'list'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(filterListCode, 0)
  const savedFilters = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ name?: string }>
  assert.ok(savedFilters.some((item) => item.name === 'CLI Filter'))

  const secondFilterCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'saved-filters',
      'create',
      'Second CLI Filter',
      '--config',
      '{"query":"second"}'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(secondFilterCode, 0)
  const secondSavedFilter = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string }

  const filterReorderCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'saved-filters',
      'reorder',
      secondSavedFilter.id ?? '',
      savedFilter.id ?? '',
      '--position',
      '0',
      '--position',
      '1'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(filterReorderCode, 0)
  assert.deepEqual(
    (JSON.parse(stdout.at(-1) ?? '[]') as Array<{ id?: string }>).map((filter) => filter.id),
    [secondSavedFilter.id, savedFilter.id]
  )

  const eventCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'calendar',
      'events',
      'create',
      'CLI event',
      '--start',
      '2026-05-14T09:00:00.000Z',
      '--end',
      '2026-05-14T10:00:00.000Z',
      '--timezone',
      'UTC'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(eventCode, 0)
  const event = JSON.parse(stdout.at(-1) ?? '{}') as { id?: string; title?: string }
  assert.equal(event.title, 'CLI event')

  const eventListCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'events', 'list'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(eventListCode, 0)
  const events = JSON.parse(stdout.at(-1) ?? '[]') as Array<{ title?: string }>
  assert.ok(events.some((item) => item.title === 'CLI event'))

  const calendarRangeCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'calendar',
      'range',
      '--start',
      '2026-05-12T00:00:00.000Z',
      '--end',
      '2026-05-15T00:00:00.000Z'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarRangeCode, 0)
  const calendarRange = JSON.parse(stdout.at(-1) ?? '{}') as {
    items?: Array<{ sourceType?: string; sourceId?: string }>
  }
  assert.equal(
    calendarRange.items?.some((item) => item.sourceType === 'event' && item.sourceId === event.id),
    true
  )
  assert.equal(
    calendarRange.items?.some(
      (item) => item.sourceType === 'task' && item.sourceId === childTask.id
    ),
    true
  )

  const calendarSourcesCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'sources'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarSourcesCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { sources?: unknown[] }).sources?.length, 0)

  const calendarProviderStatusCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'provider-status', '--provider', 'google'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarProviderStatusCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { connected?: boolean }).connected, false)

  const calendarGoogleSettingsCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'google-settings'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarGoogleSettingsCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { defaultTargetCalendarId?: string | null })
      .defaultTargetCalendarId,
    null
  )

  const calendarDefaultGoogleCode = await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'calendar',
      'set-default-google-calendar',
      'work-calendar',
      '--mark-onboarding',
      'false'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarDefaultGoogleCode, 0)
  const calendarGoogleSettingsAfterSetCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'google-settings'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarGoogleSettingsAfterSetCode, 0)
  assert.equal(
    (JSON.parse(stdout.at(-1) ?? '{}') as { defaultTargetCalendarId?: string | null })
      .defaultTargetCalendarId,
    'work-calendar'
  )

  const calendarExternalListCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'external', 'list'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarExternalListCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { events?: unknown[] }).events?.length, 0)

  const calendarBindingsListCode = await runCli(
    ['--vault', vaultPath, '--json', 'calendar', 'bindings', 'list'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  assert.equal(calendarBindingsListCode, 0)
  assert.equal((JSON.parse(stdout.at(-1) ?? '{}') as { bindings?: unknown[] }).bindings?.length, 0)

  await runCli(
    [
      '--vault',
      vaultPath,
      '--json',
      'notes',
      'update',
      note.id ?? '',
      '--append',
      '[[CLI Template]] [[Missing Note]]'
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )

  const graphCode = await runCli(['--vault', vaultPath, '--json', 'graph', 'data'], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(graphCode, 0)
  const graph = JSON.parse(stdout.at(-1) ?? '{}') as {
    nodes?: Array<{ id?: string; isUnresolved?: boolean }>
    edges?: Array<{ source?: string; target?: string }>
  }
  assert.ok(graph.nodes?.some((node) => node.id === 'ghost:Missing Note' && node.isUnresolved))

  assert.deepEqual(stderr, [])
})
