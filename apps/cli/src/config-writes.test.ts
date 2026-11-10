import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { getConfigPath } from './app-core/paths.ts'
import { runCli } from './run.ts'

// #4130: .memry/config.json holds the user's settings, which desktop also reads and writes.
// The CLI never loses them, never rewrites the file from a read command, and replaces it
// atomically when it does write.

const COMPLETE_CONFIG =
  '{"defaultNoteFolder":"","journalFolder":"journal","journalDateFormat":"YYYY-MM-DD","attachmentsFolder":"attachments"}'

async function makeVault(config: string | null): Promise<string> {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-config-writes')
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  if (config !== null) await fs.writeFile(getConfigPath(vaultPath), config, 'utf-8')
  return vaultPath
}

async function cli(t: TestContext, vaultPath: string, ...args: string[]) {
  // The unreadable-config warning goes to process.stderr; keep test output clean.
  const warnings: string[] = []
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    warnings.push(chunk)
    return true
  })
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  t.mock.restoreAll()
  return { code, stdout, stderr: stderr.join('\n'), warnings: warnings.join('') }
}

/** A second name for config.json: an in-place write changes what it reads, a replace does not. */
async function linkConfig(vaultPath: string): Promise<string> {
  const link = path.join(vaultPath, 'config-before.json')
  await fs.link(getConfigPath(vaultPath), link)
  return link
}

test('locale set refuses an unreadable config.json and leaves it byte-identical', async (t) => {
  const vaultPath = await makeVault('{ nope')

  const result = await cli(t, vaultPath, 'locale', 'set', 'de')

  assert.equal(result.code, 1, result.stdout.join('\n'))
  assert.ok(result.stderr.includes(getConfigPath(vaultPath)), result.stderr)
  assert.equal(await fs.readFile(getConfigPath(vaultPath), 'utf-8'), '{ nope')
  const current = await cli(t, vaultPath, 'locale', 'get')
  assert.notEqual(JSON.parse(current.stdout.at(-1) ?? 'null'), 'de', current.stdout.join('\n'))
})

test('locale set keeps the other settings and replaces config.json atomically', async (t) => {
  const vaultPath = await makeVault('{"excludePatterns":["private"],"journalFolder":"daily"}')
  const before = await linkConfig(vaultPath)

  const result = await cli(t, vaultPath, 'locale', 'set', 'de')

  assert.equal(result.code, 0, result.stderr)
  const written = JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<
    string,
    unknown
  >
  assert.deepEqual(written.excludePatterns, ['private'])
  assert.equal(written.journalFolder, 'daily')
  assert.deepEqual(written.preferences, { language: 'de' })
  assert.equal(
    await fs.readFile(before, 'utf-8'),
    '{"excludePatterns":["private"],"journalFolder":"daily"}'
  )
})

test('a read command leaves a complete config.json byte-identical', async (t) => {
  // As Electron writes it: every default key, no trailing newline.
  const config =
    '{"defaultNoteFolder":"","journalFolder":"journal","journalDateFormat":"YYYY-MM-DD","attachmentsFolder":"attachments","vaultIcon":"icon:Book"}'
  const vaultPath = await makeVault(config)
  const before = await fs.stat(getConfigPath(vaultPath))

  const result = await cli(t, vaultPath, 'vault', 'config')

  assert.equal(result.code, 0, result.stderr)
  assert.equal(await fs.readFile(getConfigPath(vaultPath), 'utf-8'), config)
  assert.equal((await fs.stat(getConfigPath(vaultPath))).mtimeMs, before.mtimeMs)
})

test('opening and update-config replace config.json atomically', async (t) => {
  const vaultPath = await makeVault('{"journalFolder":"daily"}')
  const beforeOpen = await linkConfig(vaultPath)

  assert.equal((await cli(t, vaultPath, 'vault', 'config')).code, 0)
  assert.equal(await fs.readFile(beforeOpen, 'utf-8'), '{"journalFolder":"daily"}')
  assert.equal(
    (JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<string, unknown>)
      .defaultNoteFolder,
    ''
  )

  await fs.rm(beforeOpen)
  const beforeUpdate = await linkConfig(vaultPath)
  const opened = await fs.readFile(beforeUpdate, 'utf-8')
  const updated = await cli(t, vaultPath, 'vault', 'update-config', '{"defaultNoteFolder":"inbox"}')

  assert.equal(updated.code, 0, updated.stderr)
  assert.equal(await fs.readFile(beforeUpdate, 'utf-8'), opened)
  assert.equal(
    (JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<string, unknown>)
      .defaultNoteFolder,
    'inbox'
  )
})

const posix = process.platform !== 'win32'

test('a replaced config.json keeps its mode; a new one is 0600', { skip: !posix }, async (t) => {
  const vaultPath = await makeVault('{"vaultIcon":"x"}')
  await fs.chmod(getConfigPath(vaultPath), 0o644)

  assert.equal((await cli(t, vaultPath, 'vault', 'config')).code, 0)
  assert.equal((await fs.stat(getConfigPath(vaultPath))).mode & 0o777, 0o644)

  await fs.chmod(getConfigPath(vaultPath), 0o664)
  const updated = await cli(t, vaultPath, 'vault', 'update-config', '{"defaultNoteFolder":"inbox"}')
  assert.equal(updated.code, 0, updated.stderr)
  assert.equal((await fs.stat(getConfigPath(vaultPath))).mode & 0o777, 0o664)

  const fresh = await makeVault(null)
  assert.equal((await cli(t, fresh, 'vault', 'config')).code, 0)
  assert.equal((await fs.stat(getConfigPath(fresh))).mode & 0o777, 0o600)
})

test(
  'locale set through a symlinked config.json updates its target',
  { skip: !posix },
  async (t) => {
    const vaultPath = await makeVault(null)
    const real = path.join(vaultPath, 'real.json')
    await fs.writeFile(real, '{"journalFolder":"daily"}', 'utf-8')
    await fs.symlink('../real.json', getConfigPath(vaultPath))

    const result = await cli(t, vaultPath, 'locale', 'set', 'de')

    assert.equal(result.code, 0, result.stderr)
    assert.ok((await fs.lstat(getConfigPath(vaultPath))).isSymbolicLink())
    const written = JSON.parse(await fs.readFile(real, 'utf-8')) as Record<string, unknown>
    assert.equal(written.journalFolder, 'daily')
    assert.deepEqual(written.preferences, { language: 'de' })
  }
)

test(
  'locale set refuses a config.json linked outside the vault and keeps the locale',
  { skip: !posix },
  async (t) => {
    const vaultPath = await makeVault(null)
    const outside = `${vaultPath}-outside.json`
    const content = COMPLETE_CONFIG
    await fs.writeFile(outside, content, 'utf-8')
    await fs.symlink(outside, getConfigPath(vaultPath))

    const result = await cli(t, vaultPath, 'locale', 'set', 'de')

    assert.equal(result.code, 1, result.stdout.join('\n'))
    assert.ok(result.stderr.includes('outside the vault'), result.stderr)
    assert.equal(await fs.readFile(outside, 'utf-8'), content)
    const current = await cli(t, vaultPath, 'locale', 'get')
    assert.notEqual(JSON.parse(current.stdout.at(-1) ?? 'null'), 'de', current.stdout.join('\n'))
  }
)

test(
  'locale set outlives a folder that cannot be synced: exit 0, file and db agree',
  { skip: !posix },
  async (t) => {
    const vaultPath = await makeVault('{"journalFolder":"daily"}')
    const vaultDir = await fs.realpath(vaultPath)
    const open = fs.open.bind(fs)
    // A volume that cannot fsync a folder (FUSE, SMB): the folder handle's sync fails EINVAL.
    t.mock.method(fs, 'open', async (target: string, ...rest: [string?, number?]) => {
      const handle = await open(target, ...rest)
      if ((await fs.stat(target)).isDirectory()) {
        handle.sync = async () => {
          throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' })
        }
      }
      return handle
    })

    const result = await cli(t, vaultPath, 'locale', 'set', 'de')

    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.warnings.includes(path.join(vaultDir, '.memry')), result.warnings)
    const written = JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<
      string,
      unknown
    >
    assert.deepEqual(written.preferences, { language: 'de' })
    const current = await cli(t, vaultPath, 'locale', 'get')
    assert.equal(JSON.parse(current.stdout.at(-1) ?? 'null'), 'de', current.stdout.join('\n'))
  }
)

test(
  'locale set refuses a dangling config.json link: exit 1, nothing created, link kept',
  { skip: !posix },
  async (t) => {
    const vaultPath = await makeVault(null)
    await fs.symlink('../missing.json', getConfigPath(vaultPath))

    const result = await cli(t, vaultPath, 'locale', 'set', 'de')

    assert.equal(result.code, 1, result.stdout.join('\n'))
    assert.ok(result.stderr.includes('link to a missing file'), result.stderr)
    assert.equal(await fs.readlink(getConfigPath(vaultPath)), '../missing.json')
    await assert.rejects(fs.stat(path.join(vaultPath, 'missing.json')), { code: 'ENOENT' })
    assert.deepEqual(await fs.readdir(path.join(vaultPath, '.memry')), ['config.json'])
  }
)

test('config.json replace retries a rename that a reader blocks', async (t) => {
  // A complete config, so opening the vault writes nothing and `locale set` is the only rename.
  const vaultPath = await makeVault(COMPLETE_CONFIG)
  const rename = fs.rename.bind(fs)
  let attempts = 0
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    attempts += 1
    if (attempts <= 2) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
    await rename(from, to)
  })

  const result = await cli(t, vaultPath, 'locale', 'set', 'de')

  assert.equal(result.code, 0, result.stderr)
  assert.equal(attempts, 3)
  const written = JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<
    string,
    unknown
  >
  assert.deepEqual(written.preferences, { language: 'de' })
})

test('a rename that stays blocked fails with a plain message and leaves the file', async (t) => {
  const content = '{"journalFolder":"daily"}'
  const vaultPath = await makeVault(content)
  t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
  })

  const result = await cli(t, vaultPath, 'locale', 'set', 'de')

  assert.equal(result.code, 1, result.stdout.join('\n'))
  assert.ok(
    result.stderr.includes(
      `Cannot replace ${getConfigPath(vaultPath)} (another program holds it open: EBUSY); retried 3 times; the file is unchanged`
    ),
    result.stderr
  )
  assert.equal(await fs.readFile(getConfigPath(vaultPath), 'utf-8'), content)
  assert.deepEqual(await fs.readdir(path.join(vaultPath, '.memry')), ['config.json'])
})

for (const [name, config] of [
  ['an unreadable config.json', '{ nope'],
  ['a non-list excludePatterns', '{"excludePatterns":"private"}']
] as const) {
  test(`vault config --json warns on ${name}, output and exit code unchanged`, async (t) => {
    const vaultPath = await makeVault(config)

    const result = await cli(t, vaultPath, 'vault', 'config')

    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.warnings.includes(getConfigPath(vaultPath)), result.warnings)
    const printed = JSON.parse(result.stdout.join('\n')) as Record<string, unknown>
    assert.deepEqual(printed.excludePatterns, [
      '.git',
      'node_modules',
      '.trash',
      '.obsidian',
      '.memry'
    ])
  })
}
