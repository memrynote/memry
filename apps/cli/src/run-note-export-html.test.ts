import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-export-html')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function ok<T = unknown>(vaultPath: string, ...args: string[]): Promise<T> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  assert.equal(code, 0, `${args.join(' ')}: ${stderr.join('\n')}`)
  return JSON.parse(stdout.join('\n')) as T
}

async function exportedBody(content: string): Promise<string> {
  const vault = await makeVault()
  const note = await ok<{ id: string }>(vault, 'notes', 'create', 'Raw', '--content', content)
  const htmlPath = path.join(vault, 'out.html')
  await ok(vault, 'notes', 'export-html', note.id, htmlPath)
  const html = await fs.readFile(htmlPath, 'utf8')
  const start = html.indexOf('<main class="note-content">')
  assert.ok(start > -1)
  return html.slice(start, html.indexOf('</main>', start))
}

test('export-html shows raw HTML the editor has no node for as text', async () => {
  const body = await exportedBody(
    'Pasted: <script>alert(document.domain)</script> done\n\nx <svg onload=alert(1)> y\n\n<iframe src="https://evil.example"></iframe>'
  )
  assert.doesNotMatch(body, /<(script|svg|iframe)\b/i)
  assert.ok(body.includes('Pasted: &lt;script&gt;alert(document.domain)&lt;/script&gt; done'))
})

test('export-html strips script addresses and handlers from handled tags and links', async () => {
  const body = await exportedBody(
    '<img src="a.png" onerror="alert(1)">\n\n[x](javascript:alert(1))\n\n<a href="javascript:alert(1)">y</a>'
  )
  assert.doesNotMatch(body, /\son\w+\s*=/i)
  assert.doesNotMatch(body, /javascript/i)
  assert.ok(body.includes('src="a.png"'))
})

test('export-html keeps what Memry writes', async () => {
  const body = await exportedBody(
    'a <span style="color:red">red</span><br>b\n\n<details data-memry-toggle>\n<summary>T</summary>\n\nin\n\n</details>'
  )
  assert.ok(body.includes('<span style="color:red">red</span>'))
  assert.ok(body.includes('<details data-memry-toggle>'))
  assert.ok(body.includes('<summary>T</summary>'))
})
