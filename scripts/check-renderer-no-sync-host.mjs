#!/usr/bin/env node
/**
 * The Tauri renderer makes no request to a memry host.
 *
 * The certificate pins live in the Rust transport (`crates/memry-desktop/src/seams/tls`); a
 * webview request to the sync server would skip them, and the webview has no pin of its own
 * (Electron pinned its renderer session, `apps/desktop/src/main/index.ts:655-689`). So every
 * sync, telemetry and feedback request goes through a Tauri command. The enforcement is the CSP:
 * `connect-src` in `apps/desktop-tauri/src-tauri/tauri.conf.json` names no memrynote.com host, so
 * the webview refuses such a request. This gate is the backstop that names the offending line
 * before a reviewer has to find it.
 *
 * It parses each renderer source file with the TypeScript compiler (comments, strings, regex
 * literals and JSX text are the parser's, never a guess) and fails on a call to `fetch`,
 * `navigator.sendBeacon`, `new WebSocket`, `new EventSource`, or `.open` in a file that uses
 * `XMLHttpRequest`, whose arguments hold a memrynote.com host (or a subdomain), a same-file
 * constant that holds one, or the sync server URL. Links the user opens (`window.open`, `href`)
 * are not requests and are not flagged.
 *
 *   node scripts/check-renderer-no-sync-host.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// TypeScript 7 has no JS API; compiler-API code uses the `typescript-6` alias (AGENTS.md).
import ts from 'typescript-6'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = join(repoRoot, 'apps/desktop-tauri/src/renderer/src')

/** `file:line` entries allowed to request a memry host, each with the reason. None today. */
const ALLOWED = new Map()

const SOURCE = /\.[cm]?[jt]sx?$/
const TEST = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
const MEMRY_DOMAIN = 'memrynote.com'
const SYNC_URL_NAMES = new Set([
  'SYNC_SERVER_URL',
  'VITE_SYNC_SERVER_URL',
  'syncServerUrl',
  'getSyncServerUrl',
  'sync_server_url'
])
const CONSTRUCTED = new Set(['WebSocket', 'EventSource'])

/**
 * Whether `text` names memrynote.com or a subdomain as its host: a URL
 * (`https://sync.memrynote.com/x`, `wss://…`), a bare host (`sync.memrynote.com`), or the part of
 * a template after an interpolation (`.memrynote.com/x` in `https://${region}.memrynote.com/x`).
 * The host itself is compared, so `memrynote.com.evil.test` or a query naming the domain is not a
 * match.
 */
function namesMemryHost(text) {
  const host = URL.canParse(text)
    ? new URL(text).hostname
    : text.split(/[/?#:]/, 1)[0].toLowerCase()
  return host === MEMRY_DOMAIN || host.endsWith(`.${MEMRY_DOMAIN}`)
}

function scriptKind(fileName) {
  return /\.[cm]?[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** The name a call goes to: `fetch` for `fetch(…)` and `window.fetch(…)`, `open` for `xhr.open(…)`. */
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

/**
 * Each request in `text` aimed at a memry host or the sync server: `{ line, call }`. `fileName`
 * picks the parser's dialect (`.tsx` parses JSX).
 */
export function findSyncHostRequests(text, fileName = 'source.tsx') {
  const file = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  )
  // A tree the parser had to recover can drop or misplace the call this looks for.
  const [problem] = file.parseDiagnostics ?? []
  if (problem) {
    const { line } = file.getLineAndCharacterOfPosition(problem.start ?? 0)
    const message = ts.flattenDiagnosticMessageText(problem.messageText, ' ')
    throw new Error(`${fileName}:${line + 1} could not be parsed: ${message}`)
  }
  const constants = new Map()
  let usesXhr = false
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer)
    }
    if (ts.isIdentifier(node) && node.text === 'XMLHttpRequest') usesXhr = true
    ts.forEachChild(node, collect)
  }
  collect(file)

  // Whether `node` (an argument) names a memry host or the sync server URL, following same-file
  // constants. `seen` stops a constant that refers to itself.
  const reaches = (node, seen = new Set()) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      return namesMemryHost(node.text)
    }
    if (ts.isIdentifier(node)) {
      if (SYNC_URL_NAMES.has(node.text)) return true
      const initializer = constants.get(node.text)
      if (initializer && !seen.has(node.text)) {
        seen.add(node.text)
        return reaches(initializer, seen)
      }
      return false
    }
    if (ts.isPropertyAccessExpression(node) && SYNC_URL_NAMES.has(node.name.text)) return true
    let found = false
    ts.forEachChild(node, (child) => {
      found ||= reaches(child, seen)
    })
    return found
  }

  const found = []
  const visit = (node) => {
    let name = null
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression)
      if (callee === 'fetch' || callee === 'sendBeacon' || (callee === 'open' && usesXhr)) {
        name = callee
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (CONSTRUCTED.has(node.expression.text)) name = node.expression.text
    }
    if (name && (node.arguments ?? []).some((argument) => reaches(argument))) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push({ line: line + 1, call: node.getText(file).split('\n')[0].trim() })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

async function sourceFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...(await sourceFiles(full)))
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function main() {
  const files = await sourceFiles(rendererRoot)
  const offenders = []
  for (const file of files) {
    const path = relative(repoRoot, file).split(sep).join('/')
    let requests
    try {
      requests = findSyncHostRequests(await readFile(file, 'utf8'), path)
    } catch (error) {
      offenders.push(error.message)
      continue
    }
    for (const { line, call } of requests) {
      if (!ALLOWED.has(`${path}:${line}`)) offenders.push(`${path}:${line}: ${call}`)
    }
  }
  if (offenders.length > 0) {
    console.error(
      'The renderer requests a memry host directly, which skips the certificate pins, or a file ' +
        'could not be parsed. Send requests through a Tauri command (the Rust transport):\n' +
        offenders.join('\n')
    )
    process.exit(1)
  }
  console.log(`Renderer sync-host check passed (${files.length} files)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
