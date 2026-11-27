import fs from 'fs'
import os from 'os'
import path from 'path'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { applyD1Migrations } from '../src/simulated-server.js'

describe('the harness D1 migrations', () => {
  let mf: Miniflare | null = null
  let dir: string | null = null

  afterEach(async () => {
    await mf?.dispose()
    mf = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('names the migration file whose statement fails', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-migrations-'))
    fs.writeFileSync(path.join(dir, '0001_good.sql'), '-- ok\nCREATE TABLE a (id TEXT);\n')
    fs.writeFileSync(
      path.join(dir, '0002_bad.sql'),
      'CREATE TABLE b (id TEXT);\nINSERT INTO missing VALUES (1);\n'
    )
    fs.writeFileSync(path.join(dir, '0003_later.sql'), 'CREATE TABLE c (id TEXT);\n')
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response(null) } }',
      d1Databases: { DB: 'migrations-test-db' }
    })

    await expect(applyD1Migrations(await mf.getD1Database('DB'), dir)).rejects.toThrow(
      /0002_bad\.sql/
    )
  })
})
